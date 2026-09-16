import smtplib
import time
from email.message import EmailMessage
from html import escape as html_escape
from typing import List, Dict, Any
from app.config import settings

# In-memory dedup cache: keys are "sn::level" strings, values are last-sent timestamps.
# Prevents the same action+level from being emailed more than once per DEDUP_WINDOW_SECS.
_escalation_sent: Dict[str, float] = {}
DEDUP_WINDOW_SECS = 4 * 60 * 60  # 4 hours


def _is_duplicate(sn: str, level: int) -> bool:
    key = f"{sn}::{level}"
    now = time.time()
    last = _escalation_sent.get(key)
    if last and (now - last) < DEDUP_WINDOW_SECS:
        return True
    _escalation_sent[key] = now
    # Evict stale entries periodically
    if len(_escalation_sent) > 500:
        stale = [k for k, v in _escalation_sent.items() if (now - v) >= DEDUP_WINDOW_SECS]
        for k in stale:
            del _escalation_sent[k]
    return False


def send_email(to_emails: List[str], subject: str, html_content: str) -> bool:
    if not settings.smtp_user or not settings.smtp_password:
        print(f"SMTP not configured — email NOT sent. TO: {to_emails} SUBJECT: {subject}")
        return False
    try:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = settings.smtp_user
        msg["To"] = ", ".join(to_emails)
        msg.set_content("Please enable HTML viewing.")
        msg.add_alternative(html_content, subtype="html")
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as server:
            server.starttls()
            server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(msg)
        return True
    except smtplib.SMTPException as e:
        print(f"Email SMTP error: {e}")
        return False
    except Exception as e:
        print(f"Email send failed: {type(e).__name__}: {e}")
        return False


def dispatch_escalation_emails(email_groups: List[Dict[str, Any]]) -> bool:
    """Send escalation emails for all matched matrix tiers.

    Each entry in email_groups has:
      - recipients: list of email addresses
      - level: escalation level
      - target_user: the specific user being notified
      - actions: list of action dicts (sn, text, due, responsible, priority)
    """
    any_sent = False
    for group in email_groups:
        recipients = group.get("recipients", [])
        level = group.get("level", 1)
        target_user = group.get("target_user", "")
        actions = group.get("actions", [])

        if not recipients or not actions:
            continue

        # Filter out already-sent action+level combos
        fresh = [a for a in actions if not _is_duplicate(a.get("sn", ""), level)]
        if not fresh:
            print(f"All {len(actions)} escalation action(s) already sent for level {level} — skipping")
            continue

        safe_target = html_escape(str(target_user))
        subject = f"TMS Escalation Level {level} — Action Items Requiring Your Attention"
        body = f"<h2>Escalation Level {level} — Assigned to {safe_target}</h2><p>The following actions are overdue and escalated to you:</p><ul>"
        for a in fresh:
            sn = html_escape(str(a.get("sn", "")))
            text = html_escape(str(a.get("text", "")))
            due = html_escape(str(a.get("due", "")))
            responsible = a.get("responsible") or "Unassigned"
            responsible = html_escape(str(responsible))
            body += f"<li><b>{sn}:</b> {text} (Due: {due}, Responsible: {responsible})</li>"
        body += "</ul>"

        if send_email(recipients, subject, body):
            any_sent = True

    return any_sent


def send_welcome_email(name: str, username: str, email: str,
                       password: str = "", superior: str = "", phone: str = "") -> bool:
    safe_name = html_escape(str(name))
    safe_user = html_escape(str(username))
    subject = f"Welcome to TMS — Your Account is Ready"
    body = (
        f"<h2>Welcome, {safe_name}!</h2>"
        f"<p>Your TMS account has been created.</p>"
        f"<p><b>Username:</b> {safe_user}</p>"
    )
    if password:
        body += f"<p><b>Password:</b> {html_escape(password)}</p>"
    if superior:
        body += f"<p><b>Reports To:</b> {html_escape(superior)}</p>"
    if phone:
        body += f"<p><b>Phone:</b> {html_escape(phone)}</p>"
    body += f"<p><a href='{settings.frontend_url}'>Login to TMS</a></p>"
    return send_email([email], subject, body)


def send_actions_email(to_email: str, responsible: str, actions: List[Dict[str, Any]]) -> bool:
    safe_name = html_escape(str(responsible))
    subject = f"TMS — All Actions for {safe_name}"
    rows = ""
    for a in actions:
        sn = html_escape(str(a.get("sn", "")))
        text = html_escape(str(a.get("text", "")))
        due = html_escape(str(a.get("due", "")) or "—")
        status = html_escape(str(a.get("status", "")))
        priority = html_escape(str(a.get("priority", "")))
        rows += (
            f"<tr>"
            f"<td style='padding:6px 10px;border:1px solid #ddd'>{sn}</td>"
            f"<td style='padding:6px 10px;border:1px solid #ddd'>{text}</td>"
            f"<td style='padding:6px 10px;border:1px solid #ddd'>{due}</td>"
            f"<td style='padding:6px 10px;border:1px solid #ddd'>{status}</td>"
            f"<td style='padding:6px 10px;border:1px solid #ddd'>{priority}</td>"
            f"</tr>"
        )
    body = (
        f"<h2>Actions for {safe_name}</h2>"
        f"<p>Total actions: <b>{len(actions)}</b></p>"
        f"<table style='border-collapse:collapse;width:100%'>"
        f"<thead><tr>"
        f"<th style='padding:6px 10px;border:1px solid #ddd;background:#f4f4f4'>SN</th>"
        f"<th style='padding:6px 10px;border:1px solid #ddd;background:#f4f4f4'>Action</th>"
        f"<th style='padding:6px 10px;border:1px solid #ddd;background:#f4f4f4'>Due</th>"
        f"<th style='padding:6px 10px;border:1px solid #ddd;background:#f4f4f4'>Status</th>"
        f"<th style='padding:6px 10px;border:1px solid #ddd;background:#f4f4f4'>Priority</th>"
        f"</tr></thead>"
        f"<tbody>{rows}</tbody></table>"
    )
    return send_email([to_email], subject, body)


def dispatch_daily_digests(digest_groups: List[Dict[str, Any]]) -> bool:
    """Send daily digest emails — each user gets their own open-action list.

    Each entry in digest_groups has:
      - email: recipient email address
      - name: user name
      - actions: list of action dicts (sn, text, due, status, priority)
    """
    any_sent = False
    for group in digest_groups:
        email = group.get("email")
        name = group.get("name", "")
        actions = group.get("actions", [])
        if not email or not actions:
            continue
        safe_name = html_escape(str(name))
        subject = f"TMS Daily Digest — {len(actions)} Open Action(s) for {safe_name}"
        rows = ""
        for a in actions:
            sn = html_escape(str(a.get("sn", "")))
            text = html_escape(str(a.get("text", "")))
            due = html_escape(str(a.get("due", "")) or "—")
            status = html_escape(str(a.get("status", "")))
            priority = html_escape(str(a.get("priority", "")))
            rows += (
                f"<tr>"
                f"<td style='padding:6px 10px;border:1px solid #ddd'>{sn}</td>"
                f"<td style='padding:6px 10px;border:1px solid #ddd'>{text}</td>"
                f"<td style='padding:6px 10px;border:1px solid #ddd'>{due}</td>"
                f"<td style='padding:6px 10px;border:1px solid #ddd'>{status}</td>"
                f"<td style='padding:6px 10px;border:1px solid #ddd'>{priority}</td>"
                f"</tr>"
            )
        body = (
            f"<h2>Daily Digest for {safe_name}</h2>"
            f"<p>You have <b>{len(actions)}</b> open action(s):</p>"
            f"<table style='border-collapse:collapse;width:100%'>"
            f"<thead><tr>"
            f"<th style='padding:6px 10px;border:1px solid #ddd;background:#f4f4f4'>SN</th>"
            f"<th style='padding:6px 10px;border:1px solid #ddd;background:#f4f4f4'>Action</th>"
            f"<th style='padding:6px 10px;border:1px solid #ddd;background:#f4f4f4'>Due</th>"
            f"<th style='padding:6px 10px;border:1px solid #ddd;background:#f4f4f4'>Status</th>"
            f"<th style='padding:6px 10px;border:1px solid #ddd;background:#f4f4f4'>Priority</th>"
            f"</tr></thead>"
            f"<tbody>{rows}</tbody></table>"
            f"<p style='margin-top:12px'><a href='{settings.frontend_url}'>Open TMS</a></p>"
        )
        if send_email([email], subject, body):
            any_sent = True
    return any_sent


def share_insights_email(to_emails: List[str], subject: str, content: str, plant: str = "") -> bool:
    safe_content = html_escape(str(content))
    safe_plant = html_escape(str(plant))
    html_body = f"<h2>TMS Insights Share</h2>"
    if safe_plant:
        html_body += f"<p><b>Plant:</b> {safe_plant}</p>"
    html_body += f"<pre style='white-space:pre-wrap;font-family:sans-serif'>{safe_content}</pre>"
    return send_email(to_emails, subject, html_body)


def send_completion_request_email(to_email: str, action_sn: str, action_text: str,
                                   responsible: str, allocator: str) -> bool:
    """Notify allocator that responsible user has requested completion."""
    safe_sn = html_escape(str(action_sn))
    safe_text = html_escape(str(action_text))
    safe_resp = html_escape(str(responsible))
    subject = f"TMS — Action {safe_sn} Pending Your Confirmation"
    body = (
        f"<h2>Action Completion Request</h2>"
        f"<p><b>{safe_resp}</b> has marked action <b>{safe_sn}</b> as complete and is requesting your confirmation.</p>"
        f"<table style='width:100%;border-collapse:collapse;margin:16px 0;'>"
        f"<tr><td style='padding:8px;font-weight:700;color:#555;'>Action</td><td style='padding:8px;'>{safe_sn}</td></tr>"
        f"<tr><td style='padding:8px;font-weight:700;color:#555;'>Description</td><td style='padding:8px;'>{safe_text}</td></tr>"
        f"<tr><td style='padding:8px;font-weight:700;color:#555;'>Requested By</td><td style='padding:8px;'>{safe_resp}</td></tr>"
        f"</table>"
        f"<p>Please review and confirm or reject this completion.</p>"
        f"<p><a href='{settings.frontend_url}' style='display:inline-block;background:#1a237e;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;'>Review Action</a></p>"
    )
    return send_email([to_email], subject, body)


def send_completion_confirmed_email(to_email: str, action_sn: str, action_text: str,
                                     confirmed_by: str) -> bool:
    """Notify responsible user that completion was confirmed."""
    safe_sn = html_escape(str(action_sn))
    safe_text = html_escape(str(action_text))
    safe_by = html_escape(str(confirmed_by))
    subject = f"TMS — Action {safe_sn} Completed"
    body = (
        f"<h2>Action Completed</h2>"
        f"<p>Your action <b>{safe_sn}</b> has been confirmed as complete by <b>{safe_by}</b>.</p>"
        f"<table style='width:100%;border-collapse:collapse;margin:16px 0;'>"
        f"<tr><td style='padding:8px;font-weight:700;color:#555;'>Action</td><td style='padding:8px;'>{safe_sn}</td></tr>"
        f"<tr><td style='padding:8px;font-weight:700;color:#555;'>Description</td><td style='padding:8px;'>{safe_text}</td></tr>"
        f"<tr><td style='padding:8px;font-weight:700;color:#555;'>Confirmed By</td><td style='padding:8px;'>{safe_by}</td></tr>"
        f"</table>"
        f"<p><a href='{settings.frontend_url}' style='display:inline-block;background:#27AE60;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;'>Open TMS</a></p>"
    )
    return send_email([to_email], subject, body)


def send_completion_rejected_email(to_email: str, action_sn: str, action_text: str,
                                    rejected_by: str) -> bool:
    """Notify responsible user that completion was rejected."""
    safe_sn = html_escape(str(action_sn))
    safe_text = html_escape(str(action_text))
    safe_by = html_escape(str(rejected_by))
    subject = f"TMS — Action {safe_sn} Reopened"
    body = (
        f"<h2>Action Reopened</h2>"
        f"<p>Your completion request for action <b>{safe_sn}</b> has been rejected by <b>{safe_by}</b>.</p>"
        f"<p>The action has been reopened and is now <b>IN PROCESS</b> again.</p>"
        f"<table style='width:100%;border-collapse:collapse;margin:16px 0;'>"
        f"<tr><td style='padding:8px;font-weight:700;color:#555;'>Action</td><td style='padding:8px;'>{safe_sn}</td></tr>"
        f"<tr><td style='padding:8px;font-weight:700;color:#555;'>Description</td><td style='padding:8px;'>{safe_text}</td></tr>"
        f"<tr><td style='padding:8px;font-weight:700;color:#555;'>Rejected By</td><td style='padding:8px;'>{safe_by}</td></tr>"
        f"</table>"
        f"<p><a href='{settings.frontend_url}' style='display:inline-block;background:#E74C3C;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;'>Open TMS</a></p>"
    )
    return send_email([to_email], subject, body)


def send_attachment_email(to_email: str, action_sn: str, action_text: str,
                          uploaded_by: str, filename: str, file_data_b64: str,
                          mimetype: str) -> bool:
    """Notify allocator that a document has been attached to an action."""
    safe_sn = html_escape(str(action_sn))
    safe_text = html_escape(str(action_text))
    safe_by = html_escape(str(uploaded_by))
    safe_fn = html_escape(str(filename))
    subject = f"TMS — Document Attached to Action {safe_sn}"
    body = (
        f"<h2>Document Attached to Action</h2>"
        f"<p><b>{safe_by}</b> has attached a document to action <b>{safe_sn}</b>.</p>"
        f"<table style='width:100%;border-collapse:collapse;margin:16px 0;'>"
        f"<tr><td style='padding:8px;font-weight:700;color:#555;'>Action</td><td style='padding:8px;'>{safe_sn}</td></tr>"
        f"<tr><td style='padding:8px;font-weight:700;color:#555;'>Description</td><td style='padding:8px;'>{safe_text}</td></tr>"
        f"<tr><td style='padding:8px;font-weight:700;color:#555;'>Document</td><td style='padding:8px;'>{safe_fn}</td></tr>"
        f"<tr><td style='padding:8px;font-weight:700;color:#555;'>Attached By</td><td style='padding:8px;'>{safe_by}</td></tr>"
        f"</table>"
        f"<p>The document is attached to this email.</p>"
        f"<p><a href='{settings.frontend_url}' style='display:inline-block;background:#1a237e;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;'>Open TMS</a></p>"
    )
    if not settings.smtp_user or not settings.smtp_password:
        print(f"SMTP not configured — attachment email NOT sent. TO: {to_email} SUBJECT: {subject}")
        return False
    try:
        import base64 as _b64
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = settings.smtp_user
        msg["To"] = to_email
        msg.set_content("Please enable HTML viewing.")
        msg.add_alternative(body, subtype="html")
        file_bytes = _b64.b64decode(file_data_b64)
        mt_parts = mimetype.split("/")
        msg.add_attachment(file_bytes, maintype=mt_parts[0], subtype=mt_parts[1] if len(mt_parts) > 1 else "octet-stream", filename=filename)
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as server:
            server.starttls()
            server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(msg)
        return True
    except smtplib.SMTPException as e:
        print(f"Attachment email SMTP error: {e}")
        return False
    except Exception as e:
        print(f"Attachment email send failed: {type(e).__name__}: {e}")
        return False
