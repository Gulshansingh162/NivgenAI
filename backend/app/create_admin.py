
from getpass import getpass

from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError

from app.database import Base, engine, SessionLocal
from app.models import User
from app.security import hash_password


def create_admin():
    # Create database tables if they do not exist.
    Base.metadata.create_all(bind=engine)

    print("\n================================")
    print("     CITYSHIELD AI ADMIN SETUP")
    print("================================\n")

    email = input("Enter admin email [admin@cityshield.ai]: ").strip().lower()
    if not email:
        email = "admin@cityshield.ai"

    full_name = input("Enter admin full name: ").strip()

    if not full_name:
        print("Error: Admin name cannot be empty.")
        return

    password = getpass("Create admin password: ")
    confirm_password = getpass("Confirm admin password: ")

    if password != confirm_password:
        print("Error: Passwords do not match.")
        return

    if len(password) < 12:
        print("Error: Password must contain at least 12 characters.")
        return

    with SessionLocal() as db:
        # Allow this initial bootstrap only when no admin exists.
        admin_count = db.scalar(
            select(func.count(User.id)).where(User.role == "admin")
        )

        if admin_count and admin_count > 0:
            print("An admin account already exists.")
            print("Initial admin setup is locked.")
            return

        # Do not overwrite an existing account.
        existing_user = db.scalar(
            select(User).where(User.email == email)
        )

        if existing_user:
            print("This email already belongs to an account.")
            print("Choose another email address.")
            return

        admin = User(
            full_name=full_name,
            email=email,
            password_hash=hash_password(password),
            role="admin",
            is_active=True,
        )

        db.add(admin)

        try:
            db.commit()
            print("\nAdmin account created successfully!")
            print("Email:", email)
            print("Role: admin")
            print("\nYou can now log in through the Admin Login page.")

        except IntegrityError:
            db.rollback()
            print("Could not create admin. This email may already exist.")


if __name__ == "__main__":
    create_admin()
