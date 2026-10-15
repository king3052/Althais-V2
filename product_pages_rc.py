"""
product_pages_rc.py: the five product pages (/platform/...) in the landing page's look (templates/product_rc.html).

Each page: a dark hero with three fact tiles, the platform strip, four numbered feature rows with real Althais screenshots
(static/media/products, taken from the built-in sample clinic, so no patient data), a pilot quote, integrations, the
step-by-step "how it works", who it's for, and the closing call to action.

Fact tiles state what the product does; they are not measured results. Quotes are from real pilots, word for word.
"""

STEPS = [("Capture", "Record the visit, upload audio or paste a transcript."),
         ("Draft", "A structured SOAP note is written from what was said."),
         ("Review", "You edit anything that needs your judgment."),
         ("Code", "ICD-10 and CPT codes are suggested, each with its reasons."),
         ("Check", "The claim is checked against CMS NCCI edits and payer rules."),
         ("Approve", "Your team signs and approves. Nothing goes out without a person."),
         ("Track", "The claim is sent, followed to payment, and denials come back ready.")]

QUOTES = {
    "tarin": ("The coding engine caught a bundling error I would have missed, the kind that comes back as a denial two weeks later when you’ve already moved on.",
              "Dr. James Tarin", "Tarin Health DPC · Pecos, TX", "/static/logos/tarin-health.png"),
    "cox": ("NCCI real-time checking is something I’ve been asking vendors to build for years. Most practices don’t find out about bundling conflicts until after the rejection.",
            "Bryan Cox", "Director, Revenue Cycle · MCH, Odessa, TX", ""),
    "gupta": ("Small clinics running lean can’t afford a billing department. Althais is built for exactly that setting, and the Althea voice layer is something I haven’t seen anywhere else.",
              "Dr. Ashish Gupta", "MD MBA, Deputy CMO · Hamilton Health Box", "/static/logos/hamilton-healthbox.png"),
}

PRODUCTS = {
    "ai-scribe": {
        "name": "AI Scribe", "kicker": "AI documentation", "step": 0,
        "title": "From conversation to signed note.",
        "lede": "Althais listens to the visit, or reads a transcript you paste, and drafts a structured SOAP note. You review it, change what you want, and sign. Nothing is final until you do.",
        "stats": [("SOAP", "Structured note"), ("4 ways", "To bring in a visit"), ("You sign", "Every note")],
        "features": [
            ("Capture", "Record it, upload it, or paste it.",
             "Start recording in the browser once the patient agrees, upload audio from another device, or paste a transcript from the tool you already use. Each line is timestamped and editable.",
             "Consent check before recording · Live, uploaded or pasted", "scribe-capture.jpg", "The transcript tab of an Althais encounter, with timestamped lines from the sample visit"),
            ("Structure", "A note organized the way reviewers read.",
             "What was said becomes Subjective, Objective, Assessment and Plan, with the vitals, problems, medications and allergies from the chart alongside. Every field stays editable.",
             "Chief complaint to plan · Chart beside the note", "scribe-note.jpg", "The Althais progress note for a sample diabetes follow-up, beside the patient chart"),
            ("Sources", "Every addition points back to the visit.",
             "When Althais adds a finding to the note, it quotes the line of the visit it came from. You can remove anything you don't want before signing.",
             "Quoted from the visit · Remove with one click", "scribe-sources.jpg", "Additions to the note, each quoting the line of the visit it came from"),
            ("Sign", "Sign once. The claim is ready too.",
             "Signing approves the note and the claim built from it, recorded with your name and the time. The signed note goes to the chart and straight into coding.",
             "Signed with your name and time · Straight to coding", "scribe-sign.jpg", "The Sign Note dialog showing the claim check, codes and additions to the note"),
        ],
        "quote": "gupta",
    },
    "medical-coding": {
        "name": "Medical Coding", "kicker": "AI medical coding", "step": 3,
        "title": "Codes you can defend.",
        "lede": "Althais reads the note and suggests ICD-10 and CPT codes, each with a confidence score and the documentation behind it. You accept, change or add every code.",
        "stats": [("ICD-10", "And CPT suggested"), ("Scored", "Confidence on each code"), ("NCCI", "Bundling checked")],
        "features": [
            ("Suggest", "The codes, the charge and the check, at a glance.",
             "As soon as the note is written, the coding panel shows the claim check, the estimated charge, any edits to resolve and the payer, with a preview of the claim lines.",
             "Built while you document · Claim preview included", "coding-suggest.jpg", "The Althais coding panel with a 95% claim check, estimated charge and claim preview"),
            ("Reasons", "Every code rests on the note.",
             "Each suggestion lists the documentation that supports it, so you can see why a level was chosen before you accept it.",
             "Documentation behind every code · Your call on each", "coding-codes.jpg", "Codes picked for a sample visit with the documentation that supports them"),
            ("Check", "Checked before it ever leaves.",
             "Every claim is compared against the CMS procedure-to-procedure edit table, so bundling conflicts are caught while the note is still open.",
             "CMS NCCI edits · Required fields checked", "claims-check.jpg", "A claim waiting for sign-off with its claim check and codes"),
            ("Payer rules", "Your payers' rules, applied for you.",
             "Payer bulletins become rules that run on every claim: what each payer requires, which codes it applies to, and which claims it would have stopped.",
             "Rules from payer bulletins · Claims affected shown", "coding-payer.jpg", "The Althais payer rules screen with rules by payer and the claims each one affects"),
        ],
        "quote": "tarin",
    },
    "claims-insurance": {
        "name": "Claims & Insurance", "kicker": "Claims and denials", "step": 4,
        "title": "From approved codes to paid claims.",
        "lede": "Althais assembles the claim, checks it before it leaves, sends it electronically once your team approves it, and follows it to payment, including the denials.",
        "stats": [("CMS-1500", "Assembled for you"), ("NCCI", "Checked before sending"), ("Approved", "By your team first")],
        "features": [
            ("Assemble", "Everything in one claim, ready to review.",
             "The visit, provider, payer, member ID, codes and charge are pulled together for you. Open the claim to see exactly what will be sent.",
             "CMS-1500 assembled · Claim check on every claim", "claims-check.jpg", "A claim detail with the claim check, codes and estimated charge"),
            ("Queues", "Every claim, in the queue it belongs in.",
             "Claims sort themselves into work queues, from waiting for sign-off to paid, so the team always knows what needs them next.",
             "Before submission to after adjudication · Bulk submit", "claims-queue.jpg", "The Althais claims screen with work queues and every claim this month"),
            ("Track", "Followed from submission to payment.",
             "Collections, the claims pipeline and denial rate sit on one screen, with tasks for anything that needs a person.",
             "Pipeline and collections · Tasks for the team", "claims-overview.jpg", "The Althais overview with today's schedule, tasks, collections and the claims pipeline"),
            ("Denials", "Denials come back with an appeal drafted.",
             "Denied claims land in their own queues with the reason, the amount and the appeal deadline. Althais drafts the appeal letter for you to edit and send.",
             "Appeal letters drafted · Deadlines tracked", "claims-denials.jpg", "The Althais denials screen with a denied sample claim and a drafted appeal letter"),
        ],
        "quote": "cox",
    },
    "althea": {
        "name": "Althea", "kicker": "The AI assistant", "step": 2,
        "title": "Ask Althea. Get back to patients.",
        "lede": "Althea is the assistant inside Althais. Ask how to do something, what a screen means, or have her add a patient or book a visit, by voice or by typing.",
        "stats": [("Voice", "Or typed"), ("In context", "Reads the open screen"), ("On / off", "Your clinic decides")],
        "features": [
            ("Ask", "Ask the way you'd ask a colleague.",
             "Tap the mic or type. Althea answers in plain language, with the steps to follow in the screen you're on.",
             "Voice or text · Plain-language answers", "althea-ask.jpg", "The Althea panel answering how to code a note"),
            ("Do", "Add a patient or book a visit, just by saying so.",
             "Tell Althea who the patient is and when they're coming in. She creates the patient and books the appointment, and asks for anything missing.",
             "New patients by voice · Booking with clash checks", "althea-patients.jpg", "The Althais patients list"),
            ("Context", "It already read the chart.",
             "Althea works from the chart and visit that are open, so questions about the patient in front of you get answers about that patient.",
             "Reads the open chart · No copying and pasting", "althea-chart.jpg", "A sample patient chart in Althais with notes, claims, medications and insurance"),
            ("Control", "On where you want her, off where you don't.",
             "Each clinic chooses where Althea is available, and every action she takes can be undone.",
             "Clinic-level controls · Undo anything", "scribe-note.jpg", "The Althais encounter screen with the Althea button in the toolbar"),
        ],
        "quote": "gupta",
    },
    "team-onboarding": {
        "name": "Team & Onboarding", "kicker": "Staff and access", "step": 5,
        "title": "Your team, set up right from day one.",
        "lede": "Invite staff, collect their credentials, assign training, and give each person exactly the access their role needs, all in one place.",
        "stats": [("One link", "To invite each person"), ("Roles", "Provider, biller, front desk"), ("Audit", "Who changed what")],
        "features": [
            ("Invite", "One invitation, and they take it from there.",
             "Send an invitation and the new hire sets up their own sign-in, uploads their documents and works through onboarding.",
             "Self-serve setup · Reminders sent for you", "team-staff.jpg", "The Althais team screen with staff, credentials and onboarding"),
            ("Access", "Exactly the access each role needs.",
             "Providers sign notes, billers work claims, and the front desk registers patients and schedules. Each person's access is shown on their profile.",
             "Role-based access · Shown per person", "team-access.jpg", "A staff profile with role, credentials, training and Althais access"),
            ("Track", "Credentials and training, never out of date.",
             "Credentials with expiry dates, training with due dates, and reminders before anything lapses.",
             "Expiry tracking · Training due dates", "team-staff.jpg", "Staff list with credentials expiring and onboarding in progress"),
            ("Schedule", "The whole clinic, on one schedule.",
             "Every provider's day in one view, with rooms, visit types and who's waiting.",
             "Providers, rooms and visit types · One view", "team-schedule.jpg", "The Althais schedule"),
        ],
        "quote": "tarin",
    },
}
