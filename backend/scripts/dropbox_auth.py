"""
One-time helper: get a long-lived Dropbox refresh token for backend/.env.

    python scripts/dropbox_auth.py                          (uses DROPBOX_APP_KEY / _SECRET from backend/.env)
    python scripts/dropbox_auth.py <APP_KEY> <APP_SECRET>

Open the printed URL, click Allow, paste the code back here. The script checks that the
token can reach Dropbox and writes the DROPBOX_* values into backend/.env.
"""
import re
import sys
from pathlib import Path

import dropbox
from dropbox import DropboxOAuth2FlowNoRedirect


def main() -> None:
    if len(sys.argv) == 3:
        app_key, app_secret = sys.argv[1], sys.argv[2]
    else:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from app.core.config import get_settings
        app_key, app_secret = get_settings().DROPBOX_APP_KEY, get_settings().DROPBOX_APP_SECRET
        if not (app_key and app_secret):
            sys.exit(__doc__)
    flow = DropboxOAuth2FlowNoRedirect(app_key, app_secret, token_access_type="offline",
                                       scope=["files.metadata.read", "files.content.read", "files.content.write"])
    print("1. Open this URL and click Allow:\n\n   " + flow.start() + "\n")
    code = input("2. Paste the authorization code here: ").strip()
    result = flow.finish(code)

    # Save first: the authorization code can be used only once, so the token must not be lost.
    # The refresh token never expires; the old short-lived access token is cleared.
    values = {"DATA_SOURCE": "dropbox", "DROPBOX_APP_KEY": app_key, "DROPBOX_APP_SECRET": app_secret,
              "DROPBOX_REFRESH_TOKEN": result.refresh_token, "DROPBOX_ACCESS_TOKEN": ""}
    env = Path(__file__).resolve().parent.parent / ".env"
    if not env.exists():
        example = env.with_name(".env.example")
        env.write_text(example.read_text(encoding="utf-8") if example.exists() else "", encoding="utf-8")
    text = env.read_text(encoding="utf-8")
    for key, value in values.items():
        line = f"{key}={value}"
        text, n = re.subn(rf"(?m)^{key}=.*$", lambda _, line=line: line, text)
        if not n:
            text += f"\n{line}\n"
    env.write_text(text, encoding="utf-8")
    print(f"\nSaved the Dropbox keys to {env}.")

    # Verify with a call covered by the requested scopes (files.metadata.read)
    try:
        with dropbox.Dropbox(oauth2_refresh_token=result.refresh_token, app_key=app_key, app_secret=app_secret) as dbx:
            dbx.files_list_folder("")
        print("Dropbox connection verified. Restart the backend to use it.")
    except Exception as exc:  # keys are saved either way; report what Dropbox said
        print(f"Keys saved, but the test call failed: {exc}")


if __name__ == "__main__":
    main()
