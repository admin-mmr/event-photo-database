# Start Here — Running `bootstrap-gcp.sh` (Beginner Guide, macOS)

**Don't panic.** You're only doing three real things:

1. Install one tool (the Google Cloud "remote control" for your Mac).
2. Log in with your Google account.
3. Run one script that sets up everything else automatically.

That's it. The script (`bootstrap-gcp.sh`) is **safe to run more than once** — if something half-finishes, just run it again. It checks what already exists before creating anything, so it won't break things or double-charge you.

Take it one numbered step at a time. Each step tells you exactly what to type and **what you should see** when it works.

---

## What you'll need before starting

- [ ] A Google account (the one for Youth4AM / mmrunners).
- [ ] About **30–40 minutes**.
- [ ] This project folder already on your Mac (it is — that's where this file lives).

---

# PART 1 — Set up your Google Cloud account (in your web browser)

This part is all point-and-click. No typing commands yet.

### Step 1.1 — Open the Google Cloud Console
Go to **https://console.cloud.google.com** and sign in with the Youth4AM Google account.

✅ *You should see:* a dashboard with a blue top bar. It might ask you to agree to terms the first time — say yes.

### Step 1.2 — Create a project
A "project" is just a container that holds all your cloud stuff.

1. At the top, click the **project dropdown** (it says "Select a project" or shows a current project name).
2. Click **"New Project"** (top-right of the little window).
3. **Name:** type `Youth4AM Event Photos`
4. Click **Create**. Wait ~20 seconds.
5. Click the project dropdown again and **select your new project** so it's the active one.

✅ *You should see:* the project name now showing in the top bar.

📝 **Write down your Project ID.** It's shown on the dashboard (often like `youth4am-event-photos-123456`). It is NOT the same as the name. You'll need it later. The ID has no spaces and can't be changed.

### Step 1.3 — Turn on billing (don't worry — the nonprofit credit covers it)
Cloud needs a billing account attached, even though your $10k/year nonprofit credit will cover the actual cost (which is tiny — see `UX_AND_GCP_ASSESSMENT.md`).

1. Left menu (the ☰ "hamburger" icon, top-left) → **Billing**.
2. If it says "This project has no billing account," click **Link a billing account** and pick your Youth4AM billing account.
   - If you don't have one yet, click **Manage billing accounts → Create account** and follow the prompts. This is also where the nonprofit credit gets applied.

✅ *You should see:* Billing page showing your project is linked to a billing account.

> 🛟 If you get stuck on billing or the nonprofit credit, that's the one part that sometimes needs Google's nonprofit team — see `GCP_Nonprofit_Credit_Application_Guide.md`. You can still continue the steps below; billing just needs to be linked before the script's final steps work.

---

# PART 2 — Install the tool and log in (on your Mac)

Now we use the **Terminal** app. It's just a window where you type commands. Think of it as texting your computer.

### Step 2.1 — Open Terminal
Press **Cmd + Space**, type `Terminal`, press **Enter**.

✅ *You should see:* a window with a blinking cursor. This is where you'll paste commands. To run a command: paste it, then press **Enter**.

> 💡 Copy a command from this guide, click into the Terminal window, paste with **Cmd + V**, press **Enter**. That's the whole rhythm.

### Step 2.2 — Check if you already have the Google Cloud tool
Paste this and press Enter:
```bash
gcloud version
```
- ✅ If you see a few lines starting with `Google Cloud SDK …` — **great, it's installed. Skip to Step 2.4.**
- ❌ If you see `command not found: gcloud` — do Step 2.3 to install it.

### Step 2.3 — Install the Google Cloud tool (only if Step 2.2 said "not found")
Easiest way on a Mac is with Homebrew. First check for Homebrew:
```bash
brew --version
```
- If that shows a version → install gcloud with:
  ```bash
  brew install --cask google-cloud-sdk
  ```
- If `brew` is also "not found", install Homebrew first (paste this, follow its prompts — it may ask for your Mac password, which won't show as you type; that's normal):
  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  ```
  Then run the `brew install --cask google-cloud-sdk` line above.

After installing, **close the Terminal window and open a new one**, then re-run `gcloud version` to confirm it now works.

✅ *You should see:* `Google Cloud SDK …` with a version number.

### Step 2.4 — Log in
This opens your web browser to confirm it's you. Paste:
```bash
gcloud auth login
```
A browser window pops up → pick the Youth4AM Google account → click **Allow**.

✅ *You should see:* "You are now logged in as …" back in the Terminal.

Now do a second login (this one lets programs you run act on your behalf):
```bash
gcloud auth application-default login
```
Same thing — browser → Allow.

✅ *You should see:* a "credentials saved" message.

---

# PART 3 — Run the script

### Step 3.1 — Tell the Terminal which folder to work in
Paste this exactly (it's the path to the cloud app inside your project):
```bash
cd "/Users/cathylin/github/mmr/event-photo-database/cloud-webapp"
```
✅ *Nothing visible happens — that's correct.* It just moved you into the right folder.

To double-check you're in the right place, paste:
```bash
ls infra/scripts
```
✅ *You should see:* `bootstrap-gcp.sh` listed (among others). If you see "No such file or directory," you're in the wrong folder — re-do the `cd` line above.

### Step 3.2 — Set your Project ID
Replace `PASTE_YOUR_PROJECT_ID_HERE` with the Project ID you wrote down in Step 1.2 (keep the quotes):
```bash
export PROJECT_ID="PASTE_YOUR_PROJECT_ID_HERE"
```
✅ *Nothing visible happens — correct.* Verify it took:
```bash
echo $PROJECT_ID
```
✅ *You should see:* your project ID printed back.

### Step 3.3 — Run the script 🎉
Paste this one line:
```bash
./infra/scripts/bootstrap-gcp.sh "$PROJECT_ID" us-central1
```

✅ *You should see:* a stream of `==>` lines like:
```
==> Using project: youth4am-event-photos-123456  region: us-central1
==> Enabling APIs (this can take a couple of minutes the first time)
==> Creating service account ...
==> Granting IAM roles
==> Creating Firestore database in us-central1
==> Creating Artifact Registry repo: cloud-webapp
...
==> bootstrap-gcp.sh complete
```

**This takes 2–5 minutes.** The "Enabling APIs" step is the slow one — that's normal, just let it sit. Don't close the window.

### Step 3.4 — When it finishes
The last lines say `==> bootstrap-gcp.sh complete`. 🎉 **You did it.**

If you also set up a GitHub repo, it prints a box like this — **copy those 4 lines into a note**, you'll paste them into GitHub later:
```
GCP_PROJECT_ID      = ...
GCP_REGION          = ...
GCP_SERVICE_ACCOUNT = ...
GCP_WORKLOAD_IDP    = ...
```
(If it says "Skipped Workload Identity Federation," that's fine — you can do that part later.)

---

# PART 4 — Check that it worked

Paste these one at a time. Each should print something (not an error):

```bash
gcloud firestore databases describe --database='(default)' --format='value(type)'
```
✅ Should print: `FIRESTORE_NATIVE`

```bash
gcloud iam service-accounts list --filter="cloud-webapp-deployer" --format='value(email)'
```
✅ Should print: an email ending in `...iam.gserviceaccount.com`

```bash
gcloud artifacts repositories describe cloud-webapp --location=us-central1 --format='value(name)'
```
✅ Should print: a path ending in `/cloud-webapp`

If all three print something, **everything is set up correctly.** You're done with bootstrap.

---

# If something goes wrong (common hiccups)

**"permission denied" when running the script**
The script isn't marked runnable yet. Paste this, then re-run Step 3.3:
```bash
chmod +x infra/scripts/bootstrap-gcp.sh
```

**"You do not currently have an active account" / not logged in**
Re-do Step 2.4 (`gcloud auth login`).

**"billing account ... is not open" or an API won't enable**
Billing isn't linked to the project yet. Go back to Step 1.3 in the browser, link billing, then re-run the script (remember: re-running is safe).

**"PERMISSION_DENIED" / "does not have permission"**
The Google account you logged in with isn't an **Owner** of the project. Ask whoever created the project to make you an Owner (Console → IAM & Admin → IAM → Grant access → role "Owner"), then re-run.

**It stopped halfway / I closed the window by accident**
No harm done. Just run Step 3.3 again. The script skips anything already created.

**Anything else**
Copy the red/error text and send it to your IT helper (or paste it back to me). The error message almost always says exactly what's missing.

---

# What's next (don't do these yet)
Once bootstrap is done, the next pieces (Cloud SQL, buckets, Drive access, deploying the app) are in `FACE_MATCHING_SETUP_RUNBOOK.md`, Phases F onward. Tackle them one at a time the same way — or ask me to walk you through the next one when you're ready.

You've done the scariest part. Nice work. 👏
