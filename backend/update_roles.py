import psycopg2
import uuid

DB_URL = "postgresql://neondb_owner:npg_EHonNegy03Oc@ep-cool-queen-ahdwwued-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require"

# ── Role updates: map EXACT DB name → new role ──
ROLE_UPDATES = {
    "Mr. Saurabh Sangla": "MD",
    "Mr. Rahul Dasondhi": "Manager",
    "Mrs. Aarti Harode": "Head",
    "Mrs. Khushbu Jaiswal": "Executive",
    "Mr. Shubham Arya": "Engineer",
    "Mr. Tarun": "Supervisor",
    "Mr. Manish Singh": "Assistant Manager",
    "Mr. Milan Jade": "Head",
    "MR Tabreiz Shiekh": "Sr. Executive",
    "Mr. Shiv Solanki": "Deputy Manager",
    "Mr. Ashish Mishra": "Supervisor",
    "Mr. Dilip": "Supervisor",
    "Mr. Umesh Kothare": "Manager",
    "Mr. A B Banerjee": "Manager",
    "Mr. V. R. Kulkarni": "Sr. Manager",
    "Mr. Krishna sharma ": "Trainer",
    "Mr. Susanta Dash": "Sr. Manager",
    "Mr J.R Gora": "Manager",
    "Mr. Parikshit Patel": "Sr. Engineer",
    "MR Mohit Patsariya": "Sr. Engineer",
    "Mr Manish Manjhi": "GM",
    "Mr. Mohit Sharma": "Assistant Manager",
    "Mr. Himanshu": "",
    "Mrs. Bhavna": "Assistant Manager",
    "Mr. Raju Suryavanshi": "Assistant Manager",
    "Mr. Anirudh Arya": "Sr. Manager",
    "Mr. Rahul Laad": "Sr. Manager",
    "Mr. Shailendra Narware": "Manager",
    "Mr. Rohit Prasad": "Data Entry Operator",
    "Mr. Pawan Dhangar": "Executive",
    "Mr. Mridul Saxena": "Manager",
    "Mrs. Urvashi Kulkarni": "Assistant Manager",
}

# ── New users to INSERT ──
# (name, username, password, role, plant_name, dept_name, superior_name, email, phone)
PLANT_ID = "P1"
NEW_USERS = [
    ("Mr. Shailesh Gunkar", "Shailesh@adroit", "TMS2026", "Sr. Executive", "Human Resource & Admin", "Ms. Aarti Harode", "shailesh@adroitindustries.com", ""),
    ("Mr. Abhishek Upadhyay", "Abhishek@adroit", "TMS2026", "Jr. Officer", "Human Resource & Admin", "Ms. Aarti Harode", "", ""),
    ("Mr. B. R. Patidar", "B.R@adroit", "TMS2026", "CFO", "Accounts / Finance", "Mr. Saurabh Sangla", "br@adroitindustries.com", ""),
    ("Mr. Sumit Purohit", "Sumit@adroit", "TMS2026", "CFO", "Accounts / Finance", "Mr. Saurabh Sangla", "sumit@adroitindustries.com", ""),
    ("Mr. Ravi Kapse", "Ravi@adroit", "TMS2026", "Executive", "Accounts / Finance", "", "", ""),
    ("Mr. Tushar Patni", "Tushar@adroit", "TMS2026", "Jr. Executive", "Accounts / Finance", "", "", ""),
    ("Mr. Jitendra Yadav", "Jitendra@adroit", "TMS2026", "Manager", "Accounts / Finance", "", "", ""),
    ("Mr. Indrajeet Tailor", "Indrajeet@adroit", "TMS2026", "CA", "Accounts / Finance", "", "", ""),
    ("Mr. Pradyuman Agarwal", "Pradyuman@adroit", "TMS2026", "CA", "Accounts / Finance", "", "", ""),
    ("Mr. Pushpendra Kumar", "Pushpendra@adroit", "TMS2026", "Manager", "Design", "Mr. Saurabh Sangla", "", ""),
    ("Mr. Rajendra Gogade", "Rajendra@adroit", "TMS2026", "", "Purchase", "Mr. Himanshu Gupta", "", ""),
    ("Ms. Aparna Singh", "Aparna@adroit", "TMS2026", "Assistant Manager", "Sales & Marketing", "", "", ""),
    ("Mr. Aditya Sisodia", "Aditya@adroit", "TMS2026", "Manager", "Sales & Marketing", "", "", ""),
    ("Mr. Mohd. Wasim Qadri", "Wasim@adroit", "TMS2026", "Sr. Executive", "IT", "", "", ""),
    ("Mr. Pranav Sharma", "Pranav@adroit", "TMS2026", "Executive", "IT", "", "", ""),
    ("Mr. Prashant Singh", "Prashant@adroit", "TMS2026", "Engineer", "IT", "", "singhprashant14012006@gmail.com", ""),
    ("Mr. Lalit Pareta", "Lalit@adroit", "TMS2026", "Assistant Manager", "Branding", "", "lalit@groupsignet.com", ""),
    ("Mr. Ravikant Kashyap", "RaviKant@adroit", "TMS2026", "Supervisor", "Production - Assy.", "", "assembly@groupsignet.com", ""),
    ("Mr Pushpraj Patel", "Pushpraj@adroit", "TMS2026", "Supervisor", "Production - Assy.", "", "", ""),
]


def main():
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()

    # Get plant and dept lookups
    cur.execute("SELECT id, name FROM plants")
    plants = {r[1]: r[0] for r in cur.fetchall()}

    cur.execute("SELECT id, name FROM departments")
    depts = {r[1]: r[0] for r in cur.fetchall()}

    print(f"Plants: {list(plants.keys())}")
    print(f"Depts: {list(depts.keys())}")
    print()

    # ── Update roles ──
    updated = 0
    for name, role in ROLE_UPDATES.items():
        cur.execute("UPDATE users SET role = %s WHERE name = %s", (role, name))
        if cur.rowcount > 0:
            updated += 1
            print(f"  UPDATED  {name} -> {role or '(empty)'}")
        else:
            print(f"  NOT FOUND  {name}")

    print(f"\n{updated} users role-updated.\n")

    # ── Insert new users ──
    inserted = 0
    for (name, username, password, role, dept_name, superior, email, phone) in NEW_USERS:
        # Check if already exists
        cur.execute("SELECT id FROM users WHERE name = %s OR username = %s", (name, username))
        if cur.fetchone():
            print(f"  SKIP (exists)  {name}")
            continue

        uid = "U" + uuid.uuid4().hex[:8]
        dept_id = depts.get(dept_name)
        plant_id = plants.get("Adroit Driveshaft") or list(plants.values())[0] if plants else None
        initials = "".join(w[0].upper() for w in name.replace(".", "").split() if w[0].isalpha())[:2]

        cur.execute("""
            INSERT INTO users (id, name, username, password, role, plant_id, dept_id, superior, phone, email, initials, is_active)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, true)
        """, (uid, name, username, password, role or None, plant_id, dept_id, superior or None, phone or None, email or None, initials))
        inserted += 1
        print(f"  INSERTED  {name} | role={role} | dept={dept_name} | superior={superior}")

    print(f"\n{inserted} new users inserted.")
    conn.commit()
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
