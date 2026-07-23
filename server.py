"""
Bangalore Convention - registration & funds management server.

Pure Python standard library (no external dependencies). Serves the static
frontend in ./public and a small JSON REST API backed by files in ./data.

Run:  python server.py     then open http://localhost:3000
"""

import json
import os
import uuid
import mimetypes
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
DATA_DIR = os.path.join(BASE_DIR, "data")
REG_FILE = os.path.join(DATA_DIR, "registrations.json")
EXP_FILE = os.path.join(DATA_DIR, "expenses.json")
PORT = int(os.environ.get("PORT", "3000"))

# Pricing configuration (INR). Single source of truth for the whole app.
PRICING = [
    {
        "id": "without-stay",
        "name": "Without Stay",
        "description": "Full convention access. Accommodation not included.",
        "price": 1500,
    },
    {
        "id": "single-sharing",
        "name": "With Stay - Single Sharing",
        "description": "Private room for one. All meals & sessions included.",
        "price": 6000,
    },
    {
        "id": "double-sharing",
        "name": "With Stay - Double Sharing",
        "description": "Room shared by two. All meals & sessions included.",
        "price": 4200,
    },
    {
        "id": "triple-sharing",
        "name": "With Stay - Triple Sharing",
        "description": "Room shared by three. All meals & sessions included.",
        "price": 3200,
    },
]


# ---------- tiny JSON storage helpers ----------
def ensure_store():
    os.makedirs(DATA_DIR, exist_ok=True)
    for f in (REG_FILE, EXP_FILE):
        if not os.path.exists(f):
            with open(f, "w", encoding="utf-8") as fh:
                fh.write("[]")


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.loads(fh.read() or "[]")
    except (OSError, ValueError):
        return []


def write_json(path, data):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)


def find_category(cat_id):
    return next((c for c in PRICING if c["id"] == cat_id), None)


def now_iso():
    return datetime.utcnow().isoformat() + "Z"


class Handler(BaseHTTPRequestHandler):
    server_version = "BangaloreConvention/1.0"

    # ---------- helpers ----------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            return {}

    def log_message(self, fmt, *args):  # quieter console
        return

    # ---------- static files ----------
    def _serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        rel = path.lstrip("/")
        full = os.path.normpath(os.path.join(PUBLIC_DIR, rel))
        # prevent path traversal outside PUBLIC_DIR
        if not full.startswith(PUBLIC_DIR):
            self._send_json({"error": "Forbidden"}, 403)
            return
        if not os.path.isfile(full):
            self._send_json({"error": "Not found"}, 404)
            return
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---------- routing ----------
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/pricing":
            return self._send_json(PRICING)
        if path == "/api/registrations":
            return self._send_json(read_json(REG_FILE))
        if path == "/api/expenses":
            return self._send_json(read_json(EXP_FILE))
        if path == "/api/dashboard":
            return self._send_json(self._dashboard())
        return self._serve_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/registrations":
            return self._create_registration()
        if path == "/api/expenses":
            return self._create_expense()
        return self._send_json({"error": "Not found"}, 404)

    def do_PATCH(self):
        path = urlparse(self.path).path
        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "registrations"]:
            return self._patch_registration(parts[2])
        return self._send_json({"error": "Not found"}, 404)

    def do_DELETE(self):
        path = urlparse(self.path).path
        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "api":
            if parts[1] == "registrations":
                return self._delete_item(REG_FILE, parts[2])
            if parts[1] == "expenses":
                return self._delete_item(EXP_FILE, parts[2])
        return self._send_json({"error": "Not found"}, 404)

    # ---------- registration handlers ----------
    def _create_registration(self):
        body = self._read_body()
        name = (body.get("name") or "").strip()
        email = (body.get("email") or "").strip()
        phone = (body.get("phone") or "").strip()
        category_id = body.get("categoryId")

        if not name or not email or not phone or not category_id:
            return self._send_json(
                {"error": "Name, email, phone and category are required."}, 400
            )
        category = find_category(category_id)
        if not category:
            return self._send_json({"error": "Invalid category selected."}, 400)

        registrations = read_json(REG_FILE)
        record = {
            "id": str(uuid.uuid4()),
            "name": name,
            "email": email,
            "phone": phone,
            "city": (body.get("city") or "").strip(),
            "gender": (body.get("gender") or "").strip(),
            "notes": (body.get("notes") or "").strip(),
            "categoryId": category["id"],
            "categoryName": category["name"],
            "amount": category["price"],
            "paid": False,
            "createdAt": now_iso(),
        }
        registrations.append(record)
        write_json(REG_FILE, registrations)
        self._send_json(record, 201)

    def _patch_registration(self, reg_id):
        body = self._read_body()
        registrations = read_json(REG_FILE)
        for r in registrations:
            if r["id"] == reg_id:
                if isinstance(body.get("paid"), bool):
                    r["paid"] = body["paid"]
                write_json(REG_FILE, registrations)
                return self._send_json(r)
        self._send_json({"error": "Not found."}, 404)

    # ---------- expense handlers ----------
    def _create_expense(self):
        body = self._read_body()
        title = (body.get("title") or "").strip()
        try:
            value = float(body.get("amount"))
        except (TypeError, ValueError):
            value = 0
        if not title or value <= 0:
            return self._send_json(
                {"error": "A title and a positive amount are required."}, 400
            )
        expenses = read_json(EXP_FILE)
        record = {
            "id": str(uuid.uuid4()),
            "title": title,
            "category": (body.get("category") or "General").strip(),
            "amount": value,
            "date": body.get("date") or date.today().isoformat(),
            "notes": (body.get("notes") or "").strip(),
            "createdAt": now_iso(),
        }
        expenses.append(record)
        write_json(EXP_FILE, expenses)
        self._send_json(record, 201)

    # ---------- shared ----------
    def _delete_item(self, path, item_id):
        items = read_json(path)
        remaining = [i for i in items if i["id"] != item_id]
        if len(remaining) == len(items):
            returnself._send_json({"error": "Not found."}, 404)
        write_json(path, remaining)
        self._send_json({"ok": True})

    def _dashboard(self):
        registrations = read_json(REG_FILE)
        expenses = read_json(EXP_FILE)

        total_pledged = sum(r.get("amount", 0) for r in registrations)
        total_collected = sum(
            r.get("amount", 0) for r in registrations if r.get("paid")
        )
        total_pending = total_pledged - total_collected
        total_expenses = sum(e.get("amount", 0) for e in expenses)
        balance = total_collected - total_expenses

        by_category = []
        for c in PRICING:
            items = [r for r in registrations if r.get("categoryId") == c["id"]]
            by_category.append(
                {
                    "id": c["id"],
                    "name": c["name"],
                    "count": len(items),
                    "amount": sum(r.get("amount", 0) for r in items),
                }
            )

        grouped = {}
        for e in expenses:
            key = e.get("category") or "General"
            g = grouped.setdefault(key, {"name": key, "amount": 0, "count": 0})
            g["amount"] += e.get("amount", 0)
            g["count"] += 1
        expense_by_category = sorted(
            grouped.values(), key=lambda x: x["amount"], reverse=True
        )

        return {
            "registrationCount": len(registrations),
            "paidCount": sum(1 for r in registrations if r.get("paid")),
            "totalPledged": total_pledged,
            "totalCollected": total_collected,
            "totalPending": total_pending,
            "totalExpenses": total_expenses,
            "balance": balance,
            "byCategory": by_category,
            "expenseByCategory": expense_by_category,
        }


def main():
    ensure_store()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Bangalore Convention runningat http://localhost:{PORT}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
