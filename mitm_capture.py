import re
import urllib.parse
from mitmproxy import http

TOKEN_FILE = r"C:\Users\Alina\.gemini\antigravity\game_bot\logs\latest_token.txt"
DEBUG_FILE = r"C:\Users\Alina\.gemini\antigravity\game_bot\logs\proxy_debug.log"

def log_debug(msg: str) -> None:
    with open(DEBUG_FILE, "a", encoding="utf-8") as f:
        f.write(msg + "\n")
    print(msg)

# Clean up debug file at startup
with open(DEBUG_FILE, "w", encoding="utf-8") as f:
    f.write("=== MITM CAPTURE DEBUG START ===\n")

# def http_connect(flow: http.HTTPFlow) -> None:
#     # Intercept CONNECT to play.hezzl.ru locally without establishing an upstream connection
#     if flow.request.method == "CONNECT" and "play.hezzl.ru" in flow.request.pretty_url:
#         log_debug(f"[HTTP_CONNECT] Intercepted CONNECT to {flow.request.pretty_url} - spoofing success")
#         flow.response = http.Response.make(200, b"", {})

def request(flow: http.HTTPFlow) -> None:
    url = flow.request.pretty_url
    log_debug(f"[REQUEST] {flow.request.method} {url}")
    
    # Log all headers to debug file for hezzl.ru
    if "hezzl.ru" in url:
        for k, v in flow.request.headers.items():
            log_debug(f"  Header -> {k}: {v[:100]}")
            
        # Check for token in URL query
        if "token=" in url:
            match = re.search(r"token=([^&]+)", url)
            if match:
                raw_token = match.group(1)
                token = urllib.parse.unquote(raw_token)
                
                # Write to the latest_token.txt
                with open(TOKEN_FILE, "w", encoding="utf-8") as f:
                    f.write(token)
                
                log_debug("\n" + "=" * 80)
                log_debug("[MITM CAPTURE] SUCCESS! Intercepted token from URL query string!")
                log_debug(f"   Token length: {len(token)} characters")
                log_debug(f"   Saved to: {TOKEN_FILE}")
                log_debug(f"   Preview: {token[:60]}...{token[-40:]}")
                log_debug("=" * 80 + "\n")
                
                # We do not intercept flow.response here anymore so that the real page can load.
                return

        # Check for authorization header (case-insensitive)
        for header_name, header_val in flow.request.headers.items():
            if header_name.lower() == "authorization" and header_val.startswith("eyJ"):
                # Write to the latest_token.txt
                with open(TOKEN_FILE, "w", encoding="utf-8") as f:
                    f.write(header_val)
                
                log_debug("\n" + "=" * 80)
                log_debug("[MITM CAPTURE] SUCCESS! Intercepted token from Authorization header!")
                log_debug(f"   Token length: {len(header_val)} characters")
                log_debug(f"   Saved to: {TOKEN_FILE}")
                log_debug(f"   Preview: {header_val[:60]}...{header_val[-40:]}")
                log_debug("=" * 80 + "\n")
                
                # We do not intercept flow.response here anymore so that real API requests succeed.
                return
