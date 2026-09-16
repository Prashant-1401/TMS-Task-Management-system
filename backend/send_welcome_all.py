"""Send welcome emails to all users without resetting passwords.
Uses synchronous psycopg2 to avoid async connection issues."""

import sys
import os
import smtplib
from email.message import EmailMessage

import psycopg2
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))


def send_welcome_email(to_email, name, username, superior="", phone=""):
    smtp_host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_user = os.getenv("SMTP_USER", "")
    smtp_pass = os.getenv("SMTP_PASSWORD", "").strip('"')
    frontend_url = os.getenv("FRONTEND_URL", "https://tms-control-management.vercel.app")

    msg = EmailMessage()
    msg["Subject"] = "Welcome to TMS — Your Account is Ready"
    msg["From"] = smtp_user
    msg["To"] = to_email

    html = f"""
    <html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
    <div style="background:#1a237e;color:#fff;padding:20px;text-align:center;">
        <h1 style="margin:0;">TMS — Task Management System</h1>
    </div>
    <div style="padding:30px;background:#f5f5f5;">
        <h2 style="color:#1a237e;">Welcome, {name}!</h2>
        <p>Your TMS account has been created and is ready to use.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;font-weight:700;color:#555;">Username</td><td style="padding:8px;font-size:16px;">{username}</td></tr>
        </table>
        {"<p><b>Reports To:</b> " + superior + "</p>" if superior else ""}
        {"<p><b>Phone:</b> " + phone + "</p>" if phone else ""}
        <p style="color:#1a237e;font-weight:600;">Please use your existing password to login.</p>
        <p><a href="{frontend_url}" style="display:inline-block;background:#1a237e;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;">Login to TMS</a></p>
    </div>
    <div style="text-align:center;padding:10px;color:#888;font-size:11px;">
        <p>This is an automated email from TMS.</p>
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
        cur.execute("SELECT name, username, email, superior, phone FROM users WHERE username = ANY(%s) AND is_active = true ORDER BY name", (filter_usernames,))
    else:
        cur.execute("SELECT name, username, email, superior, phone FROM users WHERE is_active = true ORDER BY name")
    users = cur.fetchall()

    print(f"{'='*60}")
    print(f"  TMS Welcome Email Sender")
    print(f"  {len(users)} active user(s) to process")
    print(f"{'='*60}\n")

    emailed = 0
    skipped = 0
    failed = 0
    results = []

    for name, username, email, superior, phone in users:
        if not email:
            print(f"  {name} ({username}) — NO EMAIL — skipped")
            skipped += 1
            results.append({"name": name, "username": username, "email": "—", "status": "skipped"})
            continue

        ok = send_welcome_email(email, name, username, superior or "", phone or "")
        if ok:
            print(f"  {name} ({username}) — sent to {email}")
            emailed += 1
            results.append({"name": name, "username": username, "email": email, "status": "sent"})
        else:
            print(f"  {name} ({username}) — FAILED to {email}")
            failed += 1
            results.append({"name": name, "username": username, "email": email, "status": "failed"})

    print(f"\n{'='*60}")
    print(f"  Done! {emailed} sent, {skipped} skipped, {failed} failed")
    print(f"{'='*60}")

    print(f"\n{'Name':<25} {'Username':<20} {'Email':<30} {'Status'}")
    print("-" * 95)
    for r in results:
        print(f"  {r['name']:<23} {r['username']:<20} {r['email']:<30} {r['status']}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
