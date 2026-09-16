from fastapi import APIRouter, Depends, BackgroundTasks
from app.schemas.schemas import InsightsShareReq
from app.services.email_service import share_insights_email
from app.services.whatsapp_service import share_insights_whatsapp
from app.middleware.auth import require_api_key

router = APIRouter(prefix="/api/email", tags=["Email"])


def _bg_share_insights(insights, meeting_type, plant, recipients, phones):
    import json
    content = json.dumps(insights, indent=2) if isinstance(insights, (list, dict)) else str(insights)
    subject = f"TMS Insights — {meeting_type} ({plant})"
    share_insights_email(to_emails=recipients, subject=subject, content=content, plant=plant)
    share_insights_whatsapp(insights, meeting_type, plant, phones)


@router.post("/share-insights", dependencies=[Depends(require_api_key)])
async def api_share_insights(req: InsightsShareReq, bg: BackgroundTasks):
    bg.add_task(
        _bg_share_insights,
        req.insights, req.meeting_type, req.plant, req.recipients, req.phones,
    )
    return {"status": "ok", "queued": True}
