from datetime import datetime, timedelta, timezone
from functools import wraps
import hashlib
import hmac
import json
import math
from pathlib import Path
import secrets
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request as URLRequest, urlopen
from uuid import uuid4

from flask import Flask, g, jsonify, request, send_from_directory
from jose import JWTError, jwt
from pydantic import ValidationError
from sqlalchemy import func, inspect, or_, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, joinedload, selectinload
from werkzeug.utils import secure_filename

from app.config import settings
from app.database import Base, SessionLocal, engine
from app.models import APIKey, EmergencyAlert, EmergencyUnit, Incident, IncidentUpdate, User
from app.schemas import (
    APIKeyCreate,
    AdminUserResponse,
    CitizenRegister,
    EmergencyAlertCreate,
    EmergencyUnitCreate,
    LoginRequest,
    TokenResponse,
    UserResponse,
    WorkerCreate,
)
from app.security import (
    ALGORITHM,
    create_access_token,
    hash_password,
    verify_password,
)


ROOT_DIR = Path(__file__).resolve().parents[2]
FRONTEND_DIR = ROOT_DIR / "frontend"
UPLOAD_DIR = ROOT_DIR / "uploads"
ALLOWED_IMAGE_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
INCIDENT_CATEGORIES = {
    "Flooding",
    "Accident",
    "Waste",
    "Road Damage",
}
INCIDENT_STATUSES = {
    "Reported",
    "Under Review",
    "In Progress",
    "Resolved",
    "Rejected",
}
RESOURCE_CLOSED_STATUSES = {"Resolved", "Rejected"}
FACILITY_SEARCH_RADIUS_METERS = 5000
OVERPASS_API_URL = "https://overpass-api.de/api/interpreter"

app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024 + 64 * 1024
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DEV_ORIGINS = {"http://127.0.0.1:5500", "http://localhost:5500"}

_database_initialized = False
_database_init_lock = Lock()


def initialize_database() -> None:
    global _database_initialized
    if _database_initialized:
        return

    with _database_init_lock:
        if _database_initialized:
            return

        Base.metadata.create_all(bind=engine)
        user_columns = {
            column["name"] for column in inspect(engine).get_columns("users")
        }
        with engine.begin() as connection:
            if "phone" not in user_columns:
                connection.execute(
                    text("ALTER TABLE users ADD COLUMN phone VARCHAR(30)")
                )
            if "specialization" not in user_columns:
                connection.execute(
                    text(
                        "ALTER TABLE users ADD COLUMN specialization "
                        "VARCHAR(80) NOT NULL DEFAULT 'General'"
                    )
                )
            incident_columns = {
                column["name"]
                for column in inspect(connection).get_columns("incidents")
            }
            if "assigned_worker_id" not in incident_columns:
                if engine.dialect.name == "mysql":
                    connection.execute(
                        text(
                            "ALTER TABLE incidents "
                            "ADD COLUMN assigned_worker_id INTEGER NULL, "
                            "ADD CONSTRAINT fk_incidents_assigned_worker "
                            "FOREIGN KEY (assigned_worker_id) "
                            "REFERENCES users(id) ON DELETE SET NULL"
                        )
                    )
                else:
                    connection.execute(
                        text(
                            "ALTER TABLE incidents ADD COLUMN "
                            "assigned_worker_id INTEGER NULL "
                            "REFERENCES users(id) ON DELETE SET NULL"
                        )
                    )
            if "assigned_unit_id" not in incident_columns:
                if engine.dialect.name == "mysql":
                    connection.execute(
                        text(
                            "ALTER TABLE incidents "
                            "ADD COLUMN assigned_unit_id INTEGER NULL, "
                            "ADD CONSTRAINT fk_incidents_assigned_unit "
                            "FOREIGN KEY (assigned_unit_id) "
                            "REFERENCES emergency_units(id) ON DELETE SET NULL"
                        )
                    )
                else:
                    connection.execute(
                        text(
                            "ALTER TABLE incidents ADD COLUMN "
                            "assigned_unit_id INTEGER NULL "
                            "REFERENCES emergency_units(id) ON DELETE SET NULL"
                        )
                    )
        _database_initialized = True


@app.before_request
def ensure_database_initialized() -> None:
    initialize_database()
    g.db = SessionLocal()


@app.teardown_request
def close_database_session(error: BaseException | None) -> None:
    db: Session | None = g.pop("db", None)
    if db is not None:
        if error is not None:
            db.rollback()
        db.close()


@app.after_request
def allow_live_server_origin(response):
    origin = request.headers.get("Origin")
    if origin in DEV_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Headers"] = (
            "Authorization, Content-Type"
        )
        response.headers["Access-Control-Allow-Methods"] = (
            "GET, POST, PATCH, OPTIONS"
        )
        response.headers.add("Vary", "Origin")
    return response


def db_session() -> Session:
    return g.db


def response_error(message: str, status_code: int):
    return jsonify({"detail": message}), status_code


def validated(schema, data):
    try:
        return schema.model_validate(data)
    except ValidationError as error:
        details = [
            {
                "loc": item["loc"],
                "msg": item["msg"],
                "type": item["type"],
            }
            for item in error.errors()
        ]
        return jsonify({"detail": details}), 422


def user_response(user: User) -> dict:
    return UserResponse.model_validate(user).model_dump(mode="json")


def admin_user_response(user: User) -> dict:
    return AdminUserResponse.model_validate(user).model_dump(mode="json")


def serialize_datetime(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def valid_image_signature(extension: str, header: bytes) -> bool:
    if extension in {".jpg", ".jpeg"}:
        return header.startswith(b"\xff\xd8\xff")
    if extension == ".png":
        return header.startswith(b"\x89PNG\r\n\x1a\n")
    return (
        extension == ".webp"
        and header.startswith(b"RIFF")
        and header[8:12] == b"WEBP"
    )


def require_user(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        api_key = request.headers.get("X-API-Key", "").strip()
        if api_key:
            if not api_key.startswith("csk_") or len(api_key) < 32:
                return response_error("Authentication required.", 401)

            key_prefix = api_key[:16]
            record = db_session().scalar(
                select(APIKey).where(APIKey.key_prefix == key_prefix)
            )
            supplied_hash = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
            if (
                record is None
                or not hmac.compare_digest(record.key_hash, supplied_hash)
                or record.revoked_at is not None
            ):
                return response_error("Authentication required.", 401)

            if record.expires_at is not None:
                expires_at = record.expires_at
                if expires_at.tzinfo is None:
                    expires_at = expires_at.replace(tzinfo=timezone.utc)
                if expires_at <= datetime.now(timezone.utc):
                    return response_error("API key has expired.", 401)

            user = db_session().get(User, record.owner_user_id)
            if user is None or not user.is_active:
                return response_error("Authentication required.", 401)

            g.current_user = user
            g.auth_method = "api_key"
            g.api_key_access_level = record.access_level
            return handler(*args, **kwargs)

        authorization = request.headers.get("Authorization", "")
        scheme, separator, token = authorization.partition(" ")
        if not separator or scheme.lower() != "bearer" or not token:
            return response_error("Authentication required.", 401)

        try:
            payload = jwt.decode(
                token,
                settings.jwt_secret_key,
                algorithms=[ALGORITHM],
            )
            user_id = int(payload.get("sub", ""))
        except (JWTError, TypeError, ValueError):
            return response_error("Authentication required.", 401)

        user = db_session().get(User, user_id)
        if user is None or not user.is_active:
            return response_error("Authentication required.", 401)

        g.current_user = user
        g.auth_method = "jwt"
        g.api_key_access_level = None
        return handler(*args, **kwargs)

    return wrapped


def require_role(role: str):
    def decorator(handler):
        @wraps(handler)
        @require_user
        def wrapped(*args, **kwargs):
            if g.current_user.role != role:
                return response_error(
                    f"{role.capitalize()} access required.", 403
                )
            if (
                g.auth_method == "api_key"
                and g.api_key_access_level == "read_only"
                and request.method != "GET"
            ):
                return response_error(
                    "This API key is read-only.", 403
                )
            return handler(*args, **kwargs)

        return wrapped

    return decorator


def require_admin_session(handler):
    @wraps(handler)
    @require_role("admin")
    def wrapped(*args, **kwargs):
        if g.auth_method != "jwt":
            return response_error(
                "Administrator login is required for API key management.",
                403,
            )
        return handler(*args, **kwargs)

    return wrapped


def incident_payload(incident: Incident) -> dict:
    latest_update = incident.updates[-1] if incident.updates else None
    return {
        "id": incident.id,
        "title": incident.title,
        "category": incident.category,
        "description": incident.description,
        "location": incident.location,
        "latitude": incident.latitude,
        "longitude": incident.longitude,
        "priority": incident.priority,
        "status": incident.status,
        "assigned_worker_id": incident.assigned_worker_id,
        "assigned_worker": (
            incident.assigned_worker.full_name
            if incident.assigned_worker
            else None
        ),
        "assigned_unit_id": incident.assigned_unit_id,
        "assigned_unit": (
            incident.assigned_unit.name if incident.assigned_unit else None
        ),
        "image_url": (
            f"/api/citizen/incidents/{incident.id}/image"
            if incident.image_filename
            else None
        ),
        "created_at": serialize_datetime(incident.created_at),
        "updated_at": serialize_datetime(incident.updated_at),
        "latest_update_id": latest_update.id if latest_update else None,
        "latest_update_message": (
            latest_update.message if latest_update else None
        ),
        "reporter": incident.reporter.full_name,
    }


def update_payload(update: IncidentUpdate) -> dict:
    return {
        "id": update.id,
        "status": update.status,
        "message": update.message,
        "created_at": serialize_datetime(update.created_at),
    }


def emergency_alert_payload(alert: EmergencyAlert) -> dict:
    return {
        "id": alert.id,
        "title": alert.title,
        "category": alert.category,
        "affected_location": alert.affected_location,
        "instructions": alert.instructions,
        "is_active": alert.is_active,
        "created_at": serialize_datetime(alert.created_at),
        "closed_at": (
            serialize_datetime(alert.closed_at) if alert.closed_at else None
        ),
    }


@app.errorhandler(413)
def file_too_large(_error):
    return response_error("Image must be 5 MB or smaller.", 413)


@app.get("/")
def root():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "service": settings.app_name})


@app.post("/api/auth/register")
def register_citizen():
    data = validated(CitizenRegister, request.get_json(silent=True) or {})
    if isinstance(data, tuple):
        return data

    db = db_session()
    email = str(data.email).strip().lower()
    if db.scalar(select(User).where(User.email == email)):
        return response_error(
            "An account with this email already exists.", 409
        )

    user = User(
        full_name=data.full_name.strip(),
        email=email,
        password_hash=hash_password(data.password),
        role="citizen",
    )
    db.add(user)
    try:
        db.commit()
        db.refresh(user)
    except IntegrityError:
        db.rollback()
        return response_error(
            "An account with this email already exists.", 409
        )
    return jsonify(user_response(user)), 201


@app.post("/api/auth/login")
def login():
    data = validated(LoginRequest, request.get_json(silent=True) or {})
    if isinstance(data, tuple):
        return data

    email = str(data.email).strip().lower()
    user = db_session().scalar(select(User).where(User.email == email))
    if not user or not verify_password(data.password, user.password_hash):
        return response_error("Invalid email or password.", 401)
    if not user.is_active:
        return response_error("This account is disabled.", 403)
    if user.role not in {"admin", "worker", "citizen"}:
        return response_error("This account role is not supported.", 403)

    token_data = TokenResponse(
        access_token=create_access_token(user.id, user.role),
        user=user_response(user),
    )
    return jsonify(token_data.model_dump(mode="json"))


@app.get("/api/auth/me")
@require_user
def get_me():
    return jsonify(user_response(g.current_user))


def create_incident_for_current_user():
    form = request.form
    title = form.get("title", "").strip()
    category = form.get("category", "").strip()
    description = form.get("description", "").strip()
    location = form.get("location", "").strip()
    priority = form.get("priority", "medium").strip().lower()

    if len(title) < 3 or len(title) > 160:
        return response_error("Title must be between 3 and 160 characters.", 422)
    if category not in INCIDENT_CATEGORIES:
        return response_error("Choose a valid incident category.", 422)
    if len(description) < 10 or len(description) > 5000:
        return response_error(
            "Description must be between 10 and 5000 characters.", 422
        )
    if not location or len(location) > 255:
        return response_error("Location is required (255 characters max).", 422)
    if priority not in {"low", "medium", "high", "critical"}:
        return response_error("Choose a valid priority.", 422)

    latitude = form.get("latitude", "").strip()
    longitude = form.get("longitude", "").strip()
    try:
        latitude_value = float(latitude) if latitude else None
        longitude_value = float(longitude) if longitude else None
    except ValueError:
        return response_error("Coordinates must be valid numbers.", 422)
    if (latitude_value is None) != (longitude_value is None):
        return response_error(
            "Provide both latitude and longitude, or neither.", 422
        )
    if latitude_value is not None and not -90 <= latitude_value <= 90:
        return response_error("Latitude must be between -90 and 90.", 422)
    if longitude_value is not None and not -180 <= longitude_value <= 180:
        return response_error("Longitude must be between -180 and 180.", 422)

    image = request.files.get("image")
    image_filename = None
    if image and image.filename:
        extension = Path(secure_filename(image.filename)).suffix.lower()
        if extension not in ALLOWED_IMAGE_TYPES:
            return response_error("Upload a JPG, PNG, or WebP image.", 422)
        if image.mimetype != ALLOWED_IMAGE_TYPES[extension]:
            return response_error(
                "The uploaded file type does not match its image extension.",
                422,
            )
        header = image.stream.read(12)
        image.stream.seek(0)
        if not valid_image_signature(extension, header):
            return response_error("The uploaded file is not a valid image.", 422)
        image_filename = f"{uuid4().hex}{extension}"
        image.save(UPLOAD_DIR / image_filename)

    incident = Incident(
        reporter_id=g.current_user.id,
        title=title,
        category=category,
        description=description,
        location=location,
        latitude=latitude_value,
        longitude=longitude_value,
        priority=priority,
        image_filename=image_filename,
        status="Reported",
    )
    db = db_session()
    db.add(incident)
    try:
        db.flush()
        db.add(
            IncidentUpdate(
                incident_id=incident.id,
                status="Reported",
                message="Your report has been received.",
                created_by=g.current_user.id,
            )
        )
        db.commit()
        db.refresh(incident)
    except SQLAlchemyError:
        db.rollback()
        if image_filename:
            (UPLOAD_DIR / image_filename).unlink(missing_ok=True)
        raise

    return jsonify(incident_payload(incident)), 201


@app.post("/api/citizen/incidents")
@require_role("citizen")
def create_citizen_incident():
    return create_incident_for_current_user()


@app.post("/api/worker/reports")
@require_role("worker")
def create_worker_report():
    return create_incident_for_current_user()


@app.get("/api/citizen/incidents")
@require_role("citizen")
def get_citizen_incidents():
    incidents = db_session().scalars(
        select(Incident)
        .options(
            joinedload(Incident.reporter),
            selectinload(Incident.updates),
        )
        .where(Incident.reporter_id == g.current_user.id)
        .order_by(Incident.created_at.desc())
    ).all()
    return jsonify([incident_payload(item) for item in incidents])


@app.get("/api/citizen/alerts")
@require_role("citizen")
def get_citizen_emergency_alerts():
    alerts = db_session().scalars(
        select(EmergencyAlert)
        .where(EmergencyAlert.is_active.is_(True))
        .order_by(EmergencyAlert.created_at.desc())
    ).all()
    return jsonify([emergency_alert_payload(item) for item in alerts])


def distance_in_meters(latitude: float, longitude: float, element: dict) -> float | None:
    tags = element.get("tags", {})
    if not isinstance(tags, dict):
        return None

    coordinates = element.get("center", element)
    if not isinstance(coordinates, dict):
        return None
    try:
        facility_latitude = float(coordinates["lat"])
        facility_longitude = float(coordinates["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    if (
        not math.isfinite(facility_latitude)
        or not math.isfinite(facility_longitude)
        or not -90 <= facility_latitude <= 90
        or not -180 <= facility_longitude <= 180
    ):
        return None

    latitude_radians = math.radians(latitude)
    facility_latitude_radians = math.radians(facility_latitude)
    latitude_delta = facility_latitude_radians - latitude_radians
    longitude_delta = math.radians(longitude - facility_longitude)
    haversine = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(latitude_radians)
        * math.cos(facility_latitude_radians)
        * math.sin(longitude_delta / 2) ** 2
    )
    haversine = max(0.0, min(1.0, haversine))
    return 6_371_000 * 2 * math.atan2(
        math.sqrt(haversine), math.sqrt(1 - haversine)
    )


def facility_from_element(latitude: float, longitude: float, element: dict) -> dict | None:
    tags = element.get("tags", {})
    if not isinstance(tags, dict):
        return None

    if tags.get("amenity") == "hospital":
        category = "hospital"
        fallback_name = "Hospital"
    elif (
        tags.get("emergency") == "shelter"
        or tags.get("social_facility") == "emergency_shelter"
        or (
            tags.get("amenity") == "shelter"
            and tags.get("shelter_type") == "emergency"
        )
    ):
        category = "shelter"
        fallback_name = "Designated emergency shelter"
    else:
        return None

    coordinates = element.get("center", element)
    try:
        facility_latitude = float(coordinates["lat"])
        facility_longitude = float(coordinates["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    if (
        not math.isfinite(facility_latitude)
        or not math.isfinite(facility_longitude)
        or not -90 <= facility_latitude <= 90
        or not -180 <= facility_longitude <= 180
    ):
        return None

    distance = distance_in_meters(latitude, longitude, element)
    if distance is None or distance > FACILITY_SEARCH_RADIUS_METERS:
        return None

    address = tags.get("addr:full") or ", ".join(
        part
        for part in (
            " ".join(
                value
                for value in (tags.get("addr:housenumber"), tags.get("addr:street"))
                if value
            ),
            tags.get("addr:suburb"),
            tags.get("addr:city"),
        )
        if part
    )
    return {
        "osm_type": element.get("type"),
        "osm_id": element.get("id"),
        "category": category,
        "name": tags.get("name") or tags.get("name:en") or fallback_name,
        "address": address,
        "latitude": facility_latitude,
        "longitude": facility_longitude,
        "distance_meters": round(distance),
    }


@app.get("/api/citizen/facilities")
@require_role("citizen")
def get_nearby_emergency_facilities():
    try:
        latitude = float(request.args.get("latitude", ""))
        longitude = float(request.args.get("longitude", ""))
    except ValueError:
        return response_error("Provide valid latitude and longitude.", 422)

    if (
        not math.isfinite(latitude)
        or not math.isfinite(longitude)
        or not -90 <= latitude <= 90
        or not -180 <= longitude <= 180
    ):
        return response_error("Coordinates are outside the valid range.", 422)

    query = f"""
[out:json][timeout:20];
(
  nwr(around:{FACILITY_SEARCH_RADIUS_METERS},{latitude:.6f},{longitude:.6f})["amenity"="hospital"];
  nwr(around:{FACILITY_SEARCH_RADIUS_METERS},{latitude:.6f},{longitude:.6f})["emergency"="shelter"];
  nwr(around:{FACILITY_SEARCH_RADIUS_METERS},{latitude:.6f},{longitude:.6f})["social_facility"="emergency_shelter"];
  nwr(around:{FACILITY_SEARCH_RADIUS_METERS},{latitude:.6f},{longitude:.6f})["amenity"="shelter"]["shelter_type"="emergency"];
);
out center tags;
"""
    upstream_request = URLRequest(
        OVERPASS_API_URL,
        data=urlencode({"data": query}).encode("utf-8"),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "CityShieldEmergencyFacilityFinder/1.0",
        },
        method="POST",
    )
    try:
        with urlopen(upstream_request, timeout=25) as upstream_response:
            data = json.loads(upstream_response.read())
    except (
        HTTPError,
        URLError,
        TimeoutError,
        OSError,
        UnicodeDecodeError,
        json.JSONDecodeError,
    ):
        app.logger.warning("OpenStreetMap facility lookup failed.", exc_info=True)
        return response_error(
            "Nearby facility data is temporarily unavailable. Please try again later.",
            502,
        )

    elements = data.get("elements") if isinstance(data, dict) else None
    if not isinstance(elements, list):
        app.logger.warning("OpenStreetMap returned an invalid facility response.")
        return response_error(
            "Nearby facility data is temporarily unavailable. Please try again later.",
            502,
        )

    facilities = []
    seen = set()
    for element in elements:
        if not isinstance(element, dict):
            continue
        facility = facility_from_element(latitude, longitude, element)
        if facility is None:
            continue
        key = (facility["osm_type"], facility["osm_id"])
        if key in seen:
            continue
        seen.add(key)
        facilities.append(facility)
    facilities.sort(key=lambda facility: facility["distance_meters"])
    return jsonify({
        "facilities": facilities,
        "radius_meters": FACILITY_SEARCH_RADIUS_METERS,
        "source": "OpenStreetMap",
    })


@app.get("/api/worker/reports")
@require_role("worker")
def get_worker_reports():
    incidents = db_session().scalars(
        select(Incident)
        .options(
            joinedload(Incident.reporter),
            selectinload(Incident.updates),
        )
        .where(Incident.reporter_id == g.current_user.id)
        .order_by(Incident.created_at.desc())
    ).all()
    return jsonify([incident_payload(item) for item in incidents])


@app.get("/api/worker/assigned")
@require_role("worker")
def get_worker_assignments():
    incidents = db_session().scalars(
        select(Incident)
        .options(
            joinedload(Incident.reporter),
            joinedload(Incident.assigned_worker),
            selectinload(Incident.updates),
        )
        .where(Incident.assigned_worker_id == g.current_user.id)
        .order_by(Incident.updated_at.desc())
    ).all()
    return jsonify([incident_payload(item) for item in incidents])


@app.get("/api/citizen/incidents/<int:incident_id>/updates")
@require_role("citizen")
def get_citizen_incident_updates(incident_id: int):
    incident = db_session().scalar(
        select(Incident).where(
            Incident.id == incident_id,
            Incident.reporter_id == g.current_user.id,
        )
    )
    if incident is None:
        return response_error("Report not found.", 404)

    updates = db_session().scalars(
        select(IncidentUpdate)
        .where(IncidentUpdate.incident_id == incident_id)
        .order_by(IncidentUpdate.created_at.asc(), IncidentUpdate.id.asc())
    ).all()
    return jsonify([update_payload(item) for item in updates])


@app.get("/api/worker/incidents/<int:incident_id>/updates")
@require_role("worker")
def get_worker_incident_updates(incident_id: int):
    worker_access = or_(
        Incident.reporter_id == g.current_user.id,
        Incident.assigned_worker_id == g.current_user.id,
    )
    incident = db_session().scalar(
        select(Incident).where(
            Incident.id == incident_id,
            worker_access,
        )
    )
    if incident is None:
        return response_error("Incident not found.", 404)

    updates = db_session().scalars(
        select(IncidentUpdate)
        .where(IncidentUpdate.incident_id == incident_id)
        .order_by(IncidentUpdate.created_at.asc(), IncidentUpdate.id.asc())
    ).all()
    return jsonify([update_payload(item) for item in updates])


@app.get("/api/citizen/incidents/<int:incident_id>/image")
@require_user
def get_citizen_incident_image(incident_id: int):
    if g.current_user.role == "citizen":
        image_access = Incident.reporter_id == g.current_user.id
    elif g.current_user.role == "worker":
        image_access = or_(
            Incident.reporter_id == g.current_user.id,
            Incident.assigned_worker_id == g.current_user.id,
        )
    else:
        return response_error("Report image not found.", 404)

    incident = db_session().scalar(
        select(Incident).where(
            Incident.id == incident_id,
            image_access,
        )
    )
    if incident is None or not incident.image_filename:
        return response_error("Report image not found.", 404)
    return send_from_directory(
        UPLOAD_DIR,
        incident.image_filename,
        max_age=0,
        conditional=True,
    )


@app.patch("/api/worker/assigned/<int:incident_id>")
@require_role("worker")
def update_worker_assignment(incident_id: int):
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return response_error("Expected a JSON object.", 422)
    status_value = data.get("status")
    message = data.get("message", "")
    if not isinstance(status_value, str) or status_value not in INCIDENT_STATUSES:
        return response_error("Choose a valid incident status.", 422)
    if not isinstance(message, str):
        return response_error("Update message must be text.", 422)
    message = message.strip()
    if not message:
        return response_error("Add a progress update for the response team.", 422)
    if len(message) > 1000:
        return response_error("Update message is limited to 1000 characters.", 422)

    db = db_session()
    incident = db.get(Incident, incident_id)
    if incident is None or incident.assigned_worker_id != g.current_user.id:
        return response_error("Assigned incident not found.", 404)

    incident.status = status_value
    db.add(
        IncidentUpdate(
            incident_id=incident.id,
            status=status_value,
            message=message,
            created_by=g.current_user.id,
        )
    )
    db.commit()
    db.refresh(incident)
    return jsonify(incident_payload(incident))


@app.get("/api/admin/stats")
@require_role("admin")
def get_admin_stats():
    db = db_session()
    total_incidents = db.scalar(select(func.count(Incident.id))) or 0
    critical_incidents = db.scalar(
        select(func.count(Incident.id)).where(
            Incident.priority == "critical",
            Incident.status.notin_(["Resolved", "Rejected"]),
        )
    ) or 0
    total_workers = db.scalar(
        select(func.count(User.id)).where(
            User.role == "worker",
            User.is_active.is_(True),
        )
    ) or 0
    return jsonify(
        {
            "total_incidents": total_incidents,
            "critical_incidents": critical_incidents,
            "total_workers": total_workers,
        }
    )


@app.get("/api/admin/api-keys/users")
@require_admin_session
def get_api_key_owners():
    users = db_session().scalars(
        select(User)
        .where(
            User.is_active.is_(True),
            User.role.in_(("admin", "worker", "citizen")),
        )
        .order_by(User.role, User.full_name, User.id)
    ).all()
    return jsonify([
        {
            "id": user.id,
            "full_name": user.full_name,
            "role": user.role,
        }
        for user in users
    ])


@app.get("/api/admin/api-keys")
@require_admin_session
def get_api_keys():
    records = db_session().execute(
        select(APIKey, User.full_name, User.role)
        .join(User, APIKey.owner_user_id == User.id)
        .order_by(APIKey.created_at.desc(), APIKey.id.desc())
    ).all()
    return jsonify([
        {
            "id": record.id,
            "name": record.name,
            "key_prefix": record.key_prefix,
            "access_level": record.access_level,
            "owner_user_id": record.owner_user_id,
            "owner_name": owner_name,
            "owner_role": owner_role,
            "created_at": serialize_datetime(record.created_at),
            "expires_at": (
                serialize_datetime(record.expires_at)
                if record.expires_at
                else None
            ),
            "revoked_at": (
                serialize_datetime(record.revoked_at)
                if record.revoked_at
                else None
            ),
        }
        for record, owner_name, owner_role in records
    ])


@app.post("/api/admin/api-keys")
@require_admin_session
def create_api_key():
    data = validated(APIKeyCreate, request.get_json(silent=True) or {})
    if isinstance(data, tuple):
        return data

    owner = db_session().get(User, data.owner_user_id)
    if owner is None or not owner.is_active:
        return response_error("Choose an existing active account.", 422)
    if owner.role not in {"admin", "worker", "citizen"}:
        return response_error(
            "API keys require an administrator, worker, or citizen account.",
            422,
        )

    name = data.name.strip()
    if len(name) < 2:
        return response_error("API key name must contain at least 2 characters.", 422)

    raw_key = f"csk_{secrets.token_urlsafe(32)}"
    now = datetime.now(timezone.utc)
    record = APIKey(
        name=name,
        key_prefix=raw_key[:16],
        key_hash=hashlib.sha256(raw_key.encode("utf-8")).hexdigest(),
        access_level=data.access_level,
        owner_user_id=owner.id,
        created_by_id=g.current_user.id,
        created_at=now,
        expires_at=(
            now + timedelta(days=data.expires_in_days)
            if data.expires_in_days is not None
            else None
        ),
    )
    db = db_session()
    db.add(record)
    try:
        db.commit()
        db.refresh(record)
    except IntegrityError:
        db.rollback()
        return response_error("Could not create the API key. Please try again.", 409)

    return jsonify({
        "id": record.id,
        "name": record.name,
        "key": raw_key,
        "key_prefix": record.key_prefix,
        "access_level": record.access_level,
        "owner_user_id": owner.id,
        "owner_name": owner.full_name,
        "owner_role": owner.role,
        "created_at": serialize_datetime(record.created_at),
        "expires_at": (
            serialize_datetime(record.expires_at)
            if record.expires_at
            else None
        ),
    }), 201


@app.patch("/api/admin/api-keys/<int:key_id>")
@require_admin_session
def revoke_api_key(key_id: int):
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or data.get("revoked") is not True:
        return response_error(
            "Set revoked to true to revoke this API key.", 422
        )

    record = db_session().get(APIKey, key_id)
    if record is None:
        return response_error("API key not found.", 404)
    if record.revoked_at is not None:
        return response_error("API key has already been revoked.", 409)

    record.revoked_at = datetime.now(timezone.utc)
    db_session().commit()
    return jsonify({
        "id": record.id,
        "revoked_at": serialize_datetime(record.revoked_at),
    })


@app.get("/api/admin/incidents")
@require_role("admin")
def get_admin_incidents():
    incidents = db_session().scalars(
        select(Incident)
        .options(
            joinedload(Incident.reporter),
            joinedload(Incident.assigned_unit),
            selectinload(Incident.updates),
        )
        .order_by(Incident.created_at.desc())
    ).all()
    return jsonify([incident_payload(item) for item in incidents])


@app.get("/api/admin/units")
@require_role("admin")
def get_admin_units():
    db = db_session()
    units = db.scalars(
        select(EmergencyUnit).order_by(EmergencyUnit.unit_type, EmergencyUnit.code)
    ).all()
    active_incidents = db.scalars(
        select(Incident)
        .options(joinedload(Incident.assigned_unit))
        .where(
            Incident.assigned_unit_id.is_not(None),
            Incident.status.notin_(RESOURCE_CLOSED_STATUSES),
        )
    ).all()
    assignments = {
        incident.assigned_unit_id: incident
        for incident in active_incidents
    }

    return jsonify([
        {
            "id": unit.id,
            "name": unit.name,
            "unit_type": unit.unit_type,
            "code": unit.code,
            "is_in_service": unit.is_in_service,
            "availability": (
                "Out of service"
                if not unit.is_in_service
                else "Deployed"
                if unit.id in assignments
                else "Available"
            ),
            "assigned_incident_id": (
                assignments[unit.id].id if unit.id in assignments else None
            ),
            "assigned_incident_title": (
                assignments[unit.id].title if unit.id in assignments else None
            ),
            "assigned_incident_priority": (
                assignments[unit.id].priority if unit.id in assignments else None
            ),
        }
        for unit in units
    ])


@app.post("/api/admin/units")
@require_role("admin")
def create_emergency_unit():
    data = validated(EmergencyUnitCreate, request.get_json(silent=True) or {})
    if isinstance(data, tuple):
        return data

    db = db_session()
    code = data.code.strip().upper()
    if db.scalar(select(EmergencyUnit.id).where(EmergencyUnit.code == code)):
        return response_error("A response unit with this code already exists.", 409)

    unit = EmergencyUnit(
        name=data.name.strip(),
        unit_type=data.unit_type,
        code=code,
    )
    db.add(unit)
    try:
        db.commit()
        db.refresh(unit)
    except IntegrityError:
        db.rollback()
        return response_error("A response unit with this code already exists.", 409)
    return jsonify(
        {
            "id": unit.id,
            "name": unit.name,
            "unit_type": unit.unit_type,
            "code": unit.code,
            "is_in_service": unit.is_in_service,
            "availability": "Available",
            "assigned_incident_id": None,
            "assigned_incident_title": None,
            "assigned_incident_priority": None,
        }
    ), 201


@app.patch("/api/admin/units/<int:unit_id>")
@require_role("admin")
def update_emergency_unit(unit_id: int):
    data = request.get_json(silent=True) or {}
    if (
        not isinstance(data, dict)
        or set(data) != {"is_in_service"}
        or not isinstance(data["is_in_service"], bool)
    ):
        return response_error(
            "Set is_in_service to true or false to update unit availability.",
            422,
        )

    db = db_session()
    unit = db.get(EmergencyUnit, unit_id)
    if unit is None:
        return response_error("Response unit not found.", 404)

    if not data["is_in_service"] and db.scalar(
        select(Incident.id).where(
            Incident.assigned_unit_id == unit.id,
            Incident.status.notin_(RESOURCE_CLOSED_STATUSES),
        )
    ):
        return response_error(
            "This unit is deployed. Resolve or reassign its incident before taking it out of service.",
            409,
        )

    unit.is_in_service = data["is_in_service"]
    db.commit()
    return jsonify({"id": unit.id, "is_in_service": unit.is_in_service})


@app.get("/api/admin/alerts")
@require_role("admin")
def get_admin_emergency_alerts():
    alerts = db_session().scalars(
        select(EmergencyAlert).order_by(EmergencyAlert.created_at.desc())
    ).all()
    return jsonify([emergency_alert_payload(item) for item in alerts])


@app.post("/api/admin/alerts")
@require_role("admin")
def create_emergency_alert():
    data = validated(
        EmergencyAlertCreate, request.get_json(silent=True) or {}
    )
    if isinstance(data, tuple):
        return data
    if not data.verified:
        return response_error(
            "Confirm the alert details before sending to residents.", 422
        )

    alert = EmergencyAlert(
        title=data.title.strip(),
        category=data.category,
        affected_location=data.affected_location.strip(),
        instructions=data.instructions.strip(),
        created_by=g.current_user.id,
    )
    db = db_session()
    db.add(alert)
    db.commit()
    db.refresh(alert)
    return jsonify(emergency_alert_payload(alert)), 201


@app.patch("/api/admin/alerts/<int:alert_id>")
@require_role("admin")
def close_emergency_alert(alert_id: int):
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict) or data != {"is_active": False}:
        return response_error(
            "An alert can only be closed by setting is_active to false.", 422
        )

    db = db_session()
    alert = db.get(EmergencyAlert, alert_id)
    if alert is None:
        return response_error("Emergency alert not found.", 404)
    if alert.is_active:
        alert.is_active = False
        alert.closed_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(alert)
    return jsonify(emergency_alert_payload(alert))


@app.patch("/api/admin/incidents/<int:incident_id>")
@require_role("admin")
def update_admin_incident(incident_id: int):
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return response_error("Expected a JSON object.", 422)
    status_value = data.get("status")
    message = data.get("message", "")
    has_status = "status" in data
    has_assignment = "assigned_worker_id" in data
    has_unit_assignment = "assigned_unit_id" in data
    if has_status and (
        not isinstance(status_value, str)
        or status_value not in INCIDENT_STATUSES
    ):
        return response_error("Choose a valid report status.", 422)
    if not isinstance(message, str):
        return response_error("Update message must be text.", 422)
    message = message.strip()
    if message and len(message) > 1000:
        return response_error("Update message is limited to 1000 characters.", 422)
    if not has_status and not has_assignment and not has_unit_assignment:
        return response_error(
            "Provide a status, worker assignment, or response unit assignment.",
            422,
        )

    db = db_session()
    incident = db.get(Incident, incident_id)
    if incident is None:
        return response_error("Report not found.", 404)
    if has_unit_assignment:
        unit_id = data["assigned_unit_id"]
        if unit_id is not None and (
            isinstance(unit_id, bool) or not isinstance(unit_id, int)
        ):
            return response_error("Choose a valid response unit.", 422)
        unit = db.get(EmergencyUnit, unit_id) if unit_id is not None else None
        if unit_id is not None and unit is None:
            return response_error("Choose an existing response unit.", 422)
        if unit_id is not None and incident.status in RESOURCE_CLOSED_STATUSES:
            return response_error(
                "Resolve or reopen the incident before assigning a unit.", 422
            )
        if unit is not None and not unit.is_in_service:
            return response_error(
                "This response unit is out of service.", 409
            )
        if unit is not None:
            current_assignment = db.scalar(
                select(Incident.id).where(
                    Incident.assigned_unit_id == unit.id,
                    Incident.id != incident.id,
                    Incident.status.notin_(RESOURCE_CLOSED_STATUSES),
                )
            )
            if current_assignment is not None:
                return response_error(
                    "This response unit is already deployed on another incident.",
                    409,
                )
        if incident.assigned_unit_id != unit_id:
            incident.assigned_unit_id = unit_id
            unit_message = (
                f"Response unit {unit.code} assigned."
                if unit
                else "Response unit assignment removed."
            )
            db.add(
                IncidentUpdate(
                    incident_id=incident.id,
                    status=incident.status,
                    message=unit_message,
                    created_by=g.current_user.id,
                )
            )
    if has_assignment:
        worker_id = data["assigned_worker_id"]
        if worker_id is not None and (
            isinstance(worker_id, bool) or not isinstance(worker_id, int)
        ):
            return response_error("Choose a valid worker.", 422)
        worker = db.get(User, worker_id) if worker_id is not None else None
        if worker_id is not None and (
            worker is None or worker.role != "worker" or not worker.is_active
        ):
            return response_error("Choose an active worker account.", 422)
        if incident.assigned_worker_id != worker_id:
            incident.assigned_worker_id = worker_id
            assignment_message = (
                f"Incident assigned to {worker.full_name}."
                if worker
                else "Incident assignment removed."
            )
            db.add(
                IncidentUpdate(
                    incident_id=incident.id,
                    status=incident.status,
                    message=assignment_message,
                    created_by=g.current_user.id,
                )
            )

    if has_status and incident.status != status_value:
        incident.status = status_value
        db.add(
            IncidentUpdate(
                incident_id=incident.id,
                status=status_value,
                message=message or f"Report status changed to {status_value}.",
                created_by=g.current_user.id,
            )
        )
    elif has_status and message:
        db.add(
            IncidentUpdate(
                incident_id=incident.id,
                status=status_value,
                message=message,
                created_by=g.current_user.id,
            )
        )
    elif (
        has_status
        and incident.status == status_value
        and not has_assignment
        and not has_unit_assignment
    ):
        return response_error(
            "The status is unchanged; provide an update message or select a new status.",
            422,
        )
    db.commit()
    db.refresh(incident)
    return jsonify(incident_payload(incident))


@app.get("/api/admin/workers")
@require_role("admin")
def get_admin_workers():
    workers = db_session().scalars(
        select(User)
        .where(User.role == "worker")
        .order_by(User.created_at.desc())
    ).all()
    return jsonify([admin_user_response(user) for user in workers])


@app.post("/api/admin/workers")
@require_role("admin")
def create_worker():
    data = validated(WorkerCreate, request.get_json(silent=True) or {})
    if isinstance(data, tuple):
        return data

    db = db_session()
    email = str(data.email).strip().lower()
    if db.scalar(select(User).where(User.email == email)):
        return response_error(
            "An account with this email already exists.", 409
        )

    worker = User(
        full_name=data.full_name.strip(),
        email=email,
        password_hash=hash_password(data.password),
        role="worker",
        phone=data.phone.strip() if data.phone else None,
        specialization=data.specialization.strip(),
    )
    db.add(worker)
    try:
        db.commit()
        db.refresh(worker)
    except IntegrityError:
        db.rollback()
        return response_error(
            "An account with this email already exists.", 409
        )
    return jsonify(admin_user_response(worker)), 201


@app.cli.command("init-db")
def init_db_command():
    initialize_database()
    print("CityShield database tables are ready.")


if __name__ == "__main__":
    app.run(debug=True)
