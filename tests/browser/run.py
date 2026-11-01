"""Run tests/browser/tests.js against index.html in headless Edge or Chrome.

    python tests/browser/run.py              # offline tests
    python tests/browser/run.py --network    # also routing, generator and Photon search

Set BROWSER to a browser executable to override the search below.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CANDIDATES = [
    os.environ.get("BROWSER", ""),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    shutil.which("chromium") or "", shutil.which("google-chrome") or "", shutil.which("microsoft-edge") or "",
]


def main():
    network = "--network" in sys.argv
    browser = next((c for c in CANDIDATES if c and os.path.exists(c)), None)
    if not browser:
        sys.exit("No Edge/Chrome found; set BROWSER to one.")

    # The page loads tiles by relative path, so the test copy sits next to index.html.
    page = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    inject = (f"<script>window.RF_TEST_NETWORK = {'true' if network else 'false'};</script>\n"
              '<script src="tests/browser/harness.js"></script>\n<script src="tests/browser/tests.js"></script>\n</body>')
    test_page = os.path.join(ROOT, "_browser_test.html")
    with open(test_page, "w", encoding="utf-8") as f:
        f.write(page.replace("</body>", inject))

    profile = tempfile.mkdtemp(prefix="rf-test-")
    try:
        proc = subprocess.run(
            [browser, "--headless=new", "--disable-gpu", "--disable-extensions", "--window-size=1400,900",
             f"--user-data-dir={profile}", "--enable-logging=stderr", "--v=0",
             f"--virtual-time-budget={600000 if network else 120000}", "--dump-dom",
             "file:///" + test_page.replace("\\", "/")],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900)
    finally:
        os.remove(test_page)
        shutil.rmtree(profile, ignore_errors=True)

    lines = [m.group(1) for m in re.finditer(r'"RF-TEST (.*?)", source', proc.stderr)]
    for line in lines:
        print(line)
    if not any(line.startswith("DONE") for line in lines):
        sys.exit("Tests didn't finish (page error or time budget ran out). Browser log tail:\n" + proc.stderr[-2000:])
    sys.exit(1 if any(line.startswith("FAIL") for line in lines) else 0)


if __name__ == "__main__":
    main()
