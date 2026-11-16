import os
from dotenv import load_dotenv
from google_auth_oauthlib.flow import InstalledAppFlow

load_dotenv("backend/.env")

SCOPES = ["https://www.googleapis.com/auth/adwords"]

CLIENT_CONFIG = {
    "installed": {
        "client_id": os.getenv("GOOGLE_ADS_CLIENT_ID"),
        "client_secret": os.getenv("GOOGLE_ADS_CLIENT_SECRET"),
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "redirect_uris": ["http://localhost"]
    }
}

if not CLIENT_CONFIG["installed"]["client_id"] or not CLIENT_CONFIG["installed"]["client_secret"]:
    raise ValueError("Google Ads OAuth credentials missing in backend/.env")

flow = InstalledAppFlow.from_client_config(
    CLIENT_CONFIG,
    scopes=SCOPES
)

credentials = flow.run_local_server(
    port=0,
    access_type="offline",
    prompt="consent"
)

print("\nYOUR REFRESH TOKEN:\n")
print(credentials.refresh_token)