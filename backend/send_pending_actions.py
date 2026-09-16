"""Send pending action emails to all users who have open actions."""

import os
import smtplib
from email.message import EmailMessage

import psycopg2
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))


def send_actions_email(to_email, name, actions):
    smtp_host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_user = os.getenv("SMTP_USER", "")
    smtp_pass = os.getenv("SMTP_PASSWORD", "").strip('"')
    frontend_url = os.getenv("FRONTEND_URL", "https://tms-control-management.vercel.app")

    rows = ""
    for a in actions:
        sn = a["sn"]
        text = a["text"]
        due = a["due"] or "—"
        status = a["status"]
        priority = a["priority"]
        rows += (
            f"<tr>"
            f"<td style='padding:6px 10px;border:1px solid #ddd'>{sn}</td>"
            f"<td style='padding:6px 10px;border:1px solid #ddd'>{text}</td>"
            f"<td style='padding:6px 10px;border:1px solid #ddd'>{due}</td>"
            f"<td style='padding:6px 10px;border:1px solid #ddd'>{status}</td>"
            f"<td style='padding:6px 10px;border:1px solid #ddd'>{priority}</td>"
            f"</tr>"
        )

    html = f"""
    <html><body style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;">
    <div style="background:#1a237e;color:#fff;padding:20px;text-align:center;">
        <h1 style="margin:0;">TMS — Pending Actions</h1>
    </div>
    <div style="padding:30px;background:#f5f5f5;">
        <h2 style="color:#1a237e;">Hello, {name}!</h2>
        <p>You have <b>{len(actions)}</b> pending action(s) that require your attention:</p>
        <table style='border-collapse:collapse;width:100%;margin:16px 0'>
            <thead><tr>
                <th style='padding:6px 10px;border:1px solid #ddd;background:#1a237e;color:#fff'>SN</th>
                <th style='padding:6px 10px;border:1px solid #ddd;background:#1a237e;color:#fff'>Action</th>
                <th style='padding:6px 10px;border:1px solid #ddd;background:#1a237e;color:#fff'>Due</th>
                <th style='padding:6px 10px;border:1px solid #ddd;background:#1a237e;color:#fff'>Status</th>
                <th style='padding:6px 10px;border:1px solid #ddd;background:#1a237e;color:#fff'>Priority</th>
            </tr></thead>
            <tbody>{rows}</tbody>
        </table>
        <p><a href="{frontend_url}" style="display:inline-block;background:#1a237e;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;">Open TMS</a></p>
    </div>
    <div style="text-align:center;padding:10px;color:#888;font-size:11px;">
        <p>This is an automated email from TMS.</p>
    </div>
    </body></html>"""

    msg = EmailMessage()
    msg["Subject"] = f"TMS — {len(actions)} Pending Action(s) for {name}"
    msg["From"] = smtp_user
    msg["To"] = to_email
    msg.set_content("Please enable HTML viewing.")
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

    cur.execute("""
        SELECT u.name, u.username, u.email, a.sn, a.text, a.due, a.status, a.priority
        FROM actions a
        JOIN users u ON a.responsible = u.name
        WHERE a.status NOT IN ('COMPLETED', 'DROPPED')
          AND u.is_active = true
          AND u.email IS NOT NULL AND u.email != ''
        ORDER BY u.name, a.due
    """)
    rows = cur.fetchall()

    print(f"{'='*60}")
    print(f"  TMS Pending Action Email Sender")
    print(f"  {len(rows)} action(s) found across users")
    print(f"{'='*60}\n")

    grouped = {}
    for name, username, email, sn, text, due, status, priority in rows:
        if name not in grouped:
            grouped[name] = {"email": email, "username": username, "actions": []}
        grouped[name]["actions"].append({
            "sn": sn, "text": text, "due": str(due) if due else "",
            "status": status, "priority": priority,
        })

    emailed = 0
    failed = 0
    total_actions = 0
    results = []

    for name, data in sorted(grouped.items()):
        email = data["email"]
        actions = data["actions"]
        total_actions += len(actions)

        ok = send_actions_email(email, name, actions)
        if ok:
            print(f"  {name} ({data['username']}) — {len(actions)} action(s) — sent to {email}")
            emailed += 1
            results.append({"name": name, "actions": len(actions), "email": email, "status": "sent"})
        else:
            print(f"  {name} ({data['username']}) — {len(actions)} action(s) — FAILED")
            failed += 1
            results.append({"name": name, "actions": len(actions), "email": email, "status": "failed"})

    print(f"\n{'='*60}")
    print(f"  Done! {emailed} users notified, {failed} failed")
    print(f"  Total pending actions emailed: {total_actions}")
    print(f"{'='*60}")

    print(f"\n{'Name':<25} {'Actions':<10} {'Email':<35} {'Status'}")
    print("-" * 95)
    for r in results:
        print(f"  {r['name']:<23} {r['actions']:<10} {r['email']:<35} {r['status']}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
