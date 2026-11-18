#!/usr/bin/env python3
"""BayadQR - Python CRUD for the same Firestore database the HTML pages use.
Collections: sections, students, events, payments (id = eventId_studentId), settings.
Setup:  pip install firebase-admin
        Firebase Console > Project settings > Service accounts > Generate new private key
        -> save it next to this file as serviceAccountKey.json
Examples:
  python firebase_crud.py section add "BSIT 3C Mauchly"
  python firebase_crud.py section list
  python firebase_crud.py student add "Juan Dela Cruz" --email juan@gmail.com --section "BSIT 3C Mauchly" --year "3rd"
  python firebase_crud.py student update <id> --email new@gmail.com
  python firebase_crud.py student import students.csv      # columns: full_name,email,year_level,section
  python firebase_crud.py event add "Week 1" --amount "BSIT 3C Mauchly=50" --amount "BSIT 3A=30"
  python firebase_crud.py dues sync
  python firebase_crud.py payment list --event <eventId>
  python firebase_crud.py payment set <eventId>_<studentId> --paid 25
  python firebase_crud.py student delete <id>
"""
import argparse, csv, sys, time
import firebase_admin
from firebase_admin import credentials, firestore

import os
KEY = os.environ.get("GOOGLE_KEY_FILE") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "serviceAccountKey.json")
if not os.path.exists(KEY):
    sys.exit("Missing serviceAccountKey.json next to firebase_crud.py. Firebase Console > Project settings > Service accounts > Generate new private key.")
firebase_admin.initialize_app(credentials.Certificate(KEY))
db = firestore.client()

def rows(col):
    return [{"id": d.id, **d.to_dict()} for d in db.collection(col).stream()]

def show(items, keys):
    for r in items:
        print(r["id"], "|", " | ".join(str(r.get(k, "")) for k in keys))
    print(f"-- {len(items)} row(s)")

def status(due, paid):
    if paid <= 0: return "paid" if due <= 0 else "unpaid"
    return "paid" if paid + 0.004 >= due else "partial"

def next_code():
    ref = db.collection("settings").document("counter")
    @firestore.transactional
    def run(tx):
        snap = ref.get(transaction=tx)
        n = (snap.to_dict().get("n", 0) if snap.exists else 0) + 1
        tx.set(ref, {"n": n})
        return n
    return "CICI-%05d" % run(db.transaction())

def sync_dues():
    stu, evs = rows("students"), rows("events")
    have = {p["id"]: p for p in rows("payments")}
    batch, n = db.batch(), 0
    for s in stu:
        for e in evs:
            amt = (e.get("secAmounts") or {}).get(s.get("section"))
            if amt is None: continue
            pid = f"{e['id']}_{s['id']}"
            p = have.get(pid)
            if not p:
                batch.set(db.collection("payments").document(pid), {"event_id": e["id"], "student_id": s["id"], "amount": float(amt), "paid": 0, "paid_at": None, "custom": False, "via_scan": False, "status": status(amt, 0), "synced": True}); n += 1
            elif not p.get("custom") and float(p["amount"]) != float(amt):
                batch.set(db.collection("payments").document(pid), {"amount": float(amt), "status": status(float(amt), float(p.get("paid") or 0))}, merge=True); n += 1
            if n and n % 400 == 0: batch.commit(); batch = db.batch()
    batch.commit(); print("dues synced:", n, "row(s) changed")

def add_student(f):
    f.update({"qr_code": next_code(), "qr_sent_at": None, "created": int(time.time() * 1000)})
    ref = db.collection("students").add(f)[1]
    print("added", ref.id, f["qr_code"])

def main():
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest="cmd", required=True)
    for name in ("section", "student", "event", "payment", "dues"):
        p = sp.add_parser(name); p.add_argument("action"); p.add_argument("arg", nargs="?")
        p.add_argument("--email"); p.add_argument("--section"); p.add_argument("--year"); p.add_argument("--name")
        p.add_argument("--amount", action="append", default=[]); p.add_argument("--date")
        p.add_argument("--event"); p.add_argument("--paid", type=float); p.add_argument("--due", type=float)
    a = ap.parse_args()

    if a.cmd == "section":                                       # ---- sections
        if a.action == "add": print("added", db.collection("sections").add({"name": a.arg})[1].id)
        elif a.action == "list": show(sorted(rows("sections"), key=lambda r: r["name"]), ["name"])
        elif a.action == "update": db.collection("sections").document(a.arg).set({"name": a.name}, merge=True); print("updated")
        elif a.action == "delete": db.collection("sections").document(a.arg).delete(); print("deleted")
    elif a.cmd == "student":                                     # ---- students
        if a.action == "add": add_student({"full_name": a.arg, "email": a.email or "", "year_level": a.year or "", "section": a.section or ""}); sync_dues()
        elif a.action == "list":
            r = rows("students")
            if a.section: r = [x for x in r if x.get("section") == a.section]
            show(sorted(r, key=lambda x: x["full_name"]), ["qr_code", "full_name", "section", "email"])
        elif a.action == "update":
            f = {k: v for k, v in {"full_name": a.name, "email": a.email, "year_level": a.year, "section": a.section}.items() if v is not None}
            db.collection("students").document(a.arg).set(f, merge=True); sync_dues(); print("updated")
        elif a.action == "delete":
            b = db.batch(); b.delete(db.collection("students").document(a.arg))
            for p in rows("payments"):
                if p.get("student_id") == a.arg: b.delete(db.collection("payments").document(p["id"]))
            b.commit(); print("deleted")
        elif a.action == "import":
            known = {s["name"] for s in rows("sections")}
            with open(a.arg, newline="", encoding="utf-8-sig") as fh:
                for r in csv.DictReader(fh):
                    if r.get("section") and r["section"] not in known: db.collection("sections").add({"name": r["section"]}); known.add(r["section"])
                    add_student({k: (r.get(k) or "").strip() for k in ("full_name", "email", "year_level", "section")})
            sync_dues()
    elif a.cmd == "event":                                       # ---- collections (what students pay)
        amts = {k.strip(): float(v) for k, v in (x.rsplit("=", 1) for x in a.amount)}
        if a.action == "add": print("added", db.collection("events").add({"name": a.arg, "event_date": a.date, "secAmounts": amts, "created": int(time.time() * 1000)})[1].id); sync_dues()
        elif a.action == "list": show(rows("events"), ["name", "secAmounts"])
        elif a.action == "update":
            f = {k: v for k, v in {"name": a.name, "event_date": a.date}.items() if v}
            if amts: f["secAmounts"] = amts
            db.collection("events").document(a.arg).set(f, merge=True); sync_dues(); print("updated")
        elif a.action == "delete":
            b = db.batch(); b.delete(db.collection("events").document(a.arg))
            for p in rows("payments"):
                if p.get("event_id") == a.arg: b.delete(db.collection("payments").document(p["id"]))
            b.commit(); print("deleted")
    elif a.cmd == "payment":                                     # ---- payments
        if a.action == "list":
            r = [p for p in rows("payments") if not a.event or p["event_id"] == a.event]
            show(r, ["amount", "paid", "status"])
        elif a.action == "set":
            ref = db.collection("payments").document(a.arg); cur = ref.get().to_dict() or {}
            due = a.due if a.due is not None else float(cur.get("amount", 0)); paid = a.paid if a.paid is not None else float(cur.get("paid", 0))
            ref.set({"amount": due, "paid": paid, "custom": True, "status": status(due, paid), "paid_at": int(time.time() * 1000) if paid > 0 else None}, merge=True); print("saved")
        elif a.action == "delete": db.collection("payments").document(a.arg).delete(); print("deleted")
    elif a.cmd == "dues": sync_dues()

if __name__ == "__main__":
    main()
