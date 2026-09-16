"""Set all user passwords to TMS2026 and send welcome emails with credentials."""

import sys
import os
import smtplib
from email.message import EmailMessage

import psycopg2
import bcrypt
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

FIXED_PASSWORD = "TMS2026"


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def send_welcome_email(to_email, name, username, password):
    smtp_host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_user = os.getenv("SMTP_USER", "")
    smtp_pass = os.getenv("SMTP_PASSWORD", "").strip('"')
    frontend_url = os.getenv("FRONTEND_URL", "https://tms-control-management.vercel.app")

    msg = EmailMessage()
    msg["Subject"] = "Welcome to TMS — Your Account Credentials"
    msg["From"] = smtp_user
    msg["To"] = to_email

    html = f"""
    <html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
    <div style="background:#1a237e;color:#fff;padding:20px;text-align:center;">
        <h1 style="margin:0;">TMS — Task Management System</h1>
    </div>
    <div style="padding:30px;background:#f5f5f5;">
        <h2 style="color:#1a237e;">Welcome, {name}!</h2>
        <p>Your TMS account has been created. Here are your login credentials:</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;font-weight:700;color:#555;">Username</td><td style="padding:8px;font-size:16px;">{username}</td></tr>
            <tr><td style="padding:8px;font-weight:700;color:#555;">Password</td><td style="padding:8px;font-size:16px;font-family:monospace;background:#fff;border:1px solid #ddd;">{password}</td></tr>
        </table>
        <p style="color:#e65100;font-weight:600;">Please change your password after first login.</p>
        <p><a href="{frontend_url}" style="display:inline-block;background:#1a237e;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;">Login to TMS</a></p>
    </div>
    <div style="text-align:center;padding:10px;color:#888;font-size:11px;">
        <p>This is an automated email from TMS. Do not share these credentials.</p>
    </div>
    </body></html>"""
    msg.add_alternative(html, subtype="html")
    try:
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)
        return True
    except Exception as e:
        print(f"  FAILED to send to {to_email}: {e}")
        return False


def main():
    db_url = os.getenv("DATABASE_URL", "")
    sync_url = db_url.replace("postgresql+asyncpg://", "postgresql://").strip('"')
    sync_url = sync_url.replace("?ssl=require", "")
    if "ssl" not in sync_url:
        sync_url += "?sslmode=require"

    conn = psycopg2.connect(sync_url)
    cur = conn.cursor()

    filter_usernames = sys.argv[1:] if len(sys.argv) > 1 else None

    if filter_usernames:
        cur.execute("SELECT name, username, email FROM users WHERE username = ANY(%s) AND is_active = true ORDER BY name", (filter_usernames,))
    else:
        cur.execute("SELECT name, username, email FROM users WHERE is_active = true ORDER BY name")
    users = cur.fetchall()

    hashed = hash_password(FIXED_PASSWORD)

    print(f"{'='*60}")
    print(f"  TMS Password Reset & Welcome Email")
    print(f"  Password: {FIXED_PASSWORD}")
    print(f"  {len(users)} user(s) to process")
    print(f"{'='*60}\n")

    updated = 0
    emailed = 0
    skipped = 0
    failed = 0
    results = []

    for name, username, email in users:
        cur.execute("UPDATE users SET password = %s WHERE username = %s", (hashed, username))
        conn.commit()
        updated += 1

        if not email:
            print(f"  {name} ({username}) — NO EMAIL — skipped")
            skipped += 1
            results.append({"name": name, "username": username, "email": "—", "status": "skipped"})
            continue

        ok = send_welcome_email(email, name, username, FIXED_PASSWORD)
        if ok:
            print(f"  {name} ({username}) — sent to {email}")
            emailed += 1
            results.append({"name": name, "username": username, "email": email, "status": "sent"})
        else:
            print(f"  {name} ({username}) — FAILED to {email}")
            failed += 1
            results.append({"name": name, "username": username, "email": email, "status": "failed"})

    print(f"\n{'='*60}")
    print(f"  Done! {updated} passwords reset, {emailed} sent, {skipped} skipped, {failed} failed")
    print(f"{'='*60}")

    print(f"\n{'Name':<25} {'Username':<20} {'Email':<30} {'Status'}")
    print("-" * 95)
    for r in results:
        print(f"  {r['name']:<23} {r['username']:<20} {r['email']:<30} {r['status']}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
