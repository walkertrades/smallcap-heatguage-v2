/* ===========================================================================
 * Firebase bootstrap for THE HEAT GAUGE.
 *
 * Plain JS (not JSX) and loaded with a normal <script> tag BEFORE the Babel
 * modules, so window.db / window.auth / window.storage exist by the time any
 * component renders.
 *
 * NOTE ON THIS CONFIG: a Firebase *web* apiKey is not a secret — it identifies
 * the project, it does not grant access. Google ships it in client bundles by
 * design. The only thing standing between this data and the public internet is
 * the security rules below, so those have to be right.
 *
 * ===========================================================================
 * THIS BLOCK IS THE RECORD OF TRUTH FOR THE PUBLISHED RULES.
 * If you change them in the console, change them here in the same sitting —
 * a rules file that documents something other than what's live is worse than
 * no documentation, because it gets trusted.
 *
 * RULES STATE: both rulesets below published 2026-08-15 and believed current.
 *
 * ---------------------------------------------------------------------------
 * WHY EACH NON-OBVIOUS RULE IS THE WAY IT IS
 *
 * users — READ is open to every signed-in user, not owner-only.
 *   pfSubscribe() (Profile.jsx) opens a listener on ARBITRARY uids, because the
 *   notes feed, chart credits, override provenance (✎) and grade tooltips all
 *   resolve OTHER people's CURRENT handle rather than the copy denormalised at
 *   write time. That live lookup is what makes a rename propagate to old
 *   records. Owner-only read silently breaks all of it: the error is swallowed
 *   at Profile.jsx:66 and the UI falls back to the stored name, so it LOOKS
 *   fine — and looks perfectly fine when testing solo, since your own uid is
 *   the one case that passes. Writes stay owner-only.
 *   Tradeoff accepted: profile docs carry `email`, so it is readable by any
 *   signed-in user. That's the three of us.
 *
 * usernames/{name} — `get` is PUBLIC, deliberately.
 *   pfUsernameTaken() runs at Auth.jsx:219, BEFORE
 *   createUserWithEmailAndPassword — there is no request.auth to check yet.
 *   Requiring auth here fails the availability check, and because Auth.jsx:220
 *   swallows it and Auth.jsx:239 swallows the claim failure too, signup
 *   succeeds while uniqueness is NOT enforced and two people can hold the same
 *   handle. `list` stays closed so the handle directory can't be enumerated.
 *
 * usernames update — must be ALLOWED for the owner (was `if false`).
 *   pfClaimUsername() claims via a transactional set(), which counts as an
 *   UPDATE whenever the doc already exists. `if false` blocks re-claiming a
 *   handle you already own. Owner is checked on both the existing and incoming
 *   doc, so a handle still can't be stolen.
 *
 * chartsAuto — write: if false, and that is NOT the real protection.
 *   The pipeline writes it with the Firebase Admin SDK, which BYPASSES rules
 *   entirely. This block only stops browsers forging auto slots. The actual
 *   guarantee that the pipeline can never destroy a manual upload is
 *   STRUCTURAL: auto charts live in a different collection from `charts`, so a
 *   rules-bypassing write physically cannot reach manual data.
 *
 * grades — the doc ID IS the uid.
 *   That's what makes "a user can only write their own grade" a rule that
 *   cannot be spoofed: no field on the document is trusted for ownership.
 * ---------------------------------------------------------------------------
 *
 * STEP 1 — Firebase Console -> Firestore Database -> Rules tab -> paste -> Publish
 *
 *   rules_version = '2';
 *   service cloud.firestore {
 *     match /databases/{database}/documents {
 *
 *       match /users/{uid} {
 *         allow read:  if request.auth != null;
 *         allow write: if request.auth != null && request.auth.uid == uid;
 *       }
 *
 *       // one doc per lowercased handle, { uid, username }
 *       match /usernames/{name} {
 *         allow get:    if true;
 *         allow list:   if false;
 *         allow create: if request.auth != null
 *                       && request.resource.data.uid == request.auth.uid;
 *         allow update: if request.auth != null
 *                       && resource.data.uid == request.auth.uid
 *                       && request.resource.data.uid == request.auth.uid;
 *         allow delete: if request.auth != null
 *                       && resource.data.uid == request.auth.uid;
 *       }
 *
 *       // Manual chart uploads. Now holds a `manual` map of up to four
 *       // timeframes (1m / 5m / 15m / 1D) rather than a single flat image, so
 *       // the doc no longer has ONE owner — different people can fill
 *       // different slots. Removing a slot is an UPDATE (FieldValue.delete on
 *       // manual.{tf}); whole-doc delete is only for cleaning up an empty doc,
 *       // and the rule enforces that so a full set can't be nuked in one call.
 *       match /charts/{chartId} {
 *         allow read:   if request.auth != null;
 *         allow create: if request.auth != null;
 *         allow update: if request.auth != null;
 *         allow delete: if request.auth != null
 *                       && (!('manual' in resource.data)
 *                           || resource.data.manual.size() == 0);
 *       }
 *
 *       // pipeline-generated charts (item 10) — Admin SDK only
 *       match /chartsAuto/{chartId} {
 *         allow read:  if request.auth != null;
 *         allow write: if false;
 *       }
 *
 *       match /notes/{noteId}/comments/{commentId} {
 *         allow read:   if request.auth != null;
 *         allow create: if request.auth != null;
 *         allow delete: if request.auth != null
 *                       && request.auth.uid == resource.data.authorUid;
 *       }
 *
 *       // manual override layer (src/overrides.jsx) — one doc per runner at
 *       // {TICKER}-{date}, holding catalyst / country / themes / behavior /
 *       // customTags. Group-shared by design: anyone signed in may set any
 *       // override, because all three of us are describing the same tape.
 *       match /overrides/{key} {
 *         allow read:  if request.auth != null;
 *         allow write: if request.auth != null;
 *       }
 *
 *       // per-user grades (item 6) — everyone reads everyone's
 *       match /grades/{key}/gradeVotes/{uid} {
 *         allow read:   if request.auth != null;
 *         allow write:  if request.auth != null && request.auth.uid == uid;
 *         allow delete: if request.auth != null && request.auth.uid == uid;
 *       }
 *     }
 *   }
 *
 * STEP 2 — PASTE INTO: Firebase Console -> Storage -> Rules tab -> Publish
 * Storage is a SEPARATE ruleset from Firestore; publishing step 1 does NOT
 * publish this. Profile picture uploads fail with storage/unauthorized until
 * this is pasted and published.
 *
 *   rules_version = '2';
 *   service firebase.storage {
 *     match /b/{bucket}/o {
 *       match /avatars/{userId} {
 *         allow read: if request.auth != null;
 *         allow write: if request.auth.uid == userId;
 *       }
 *       // !! ORDER AND WILDCARD SHAPE ARE LOAD-BEARING HERE !!
 *       // Firebase Security Rules are a PERMISSIVE UNION: if any matching rule
 *       // grants access, access is granted. A broad grant CANNOT be narrowed by
 *       // a more specific `allow write: if false` underneath it. So the manual
 *       // rule below uses a SINGLE-SEGMENT wildcard {fileName}, which matches
 *       //     charts/AAPL-2026-08-10-1m-uid.png        (manual, 1 segment)
 *       // but NOT
 *       //     charts/auto/AAPL-2026-08-10-1m.png       (auto,   2 segments)
 *       // Using {allPaths=**} here would silently make every auto image
 *       // browser-writable no matter what the auto rule says.
 *       match /charts/{fileName} {
 *         allow read:  if request.auth != null;
 *         allow write: if request.auth != null;
 *       }
 *       // Pipeline-written images. Browsers read, never write. The Admin SDK
 *       // bypasses rules entirely, which is exactly why auto lives on its own
 *       // path: the separation is structural, not policy.
 *       match /charts/auto/{fileName} {
 *         allow read:  if request.auth != null;
 *         allow write: if false;
 *       }
 *     }
 *   }
 *
 * NOTE ON THE AVATAR PATH: `match /avatars/{userId}` binds {userId} to the WHOLE
 * object name, so the upload path must be exactly `avatars/{uid}` with no file
 * extension — `avatars/{uid}.jpg` would make userId "abc123.jpg", which never
 * equals request.auth.uid and is denied. pfUploadAvatar() in Profile.jsx writes
 * to `avatars/{uid}` to match. The contentType is set on the upload metadata
 * instead of being carried by the name.
 *
 * CHART DOC SHAPE (item 10):
 *   charts/{TICKER}-{date}      { ticker, date, manual: { "1m"|"5m"|"15m"|"1D": {...} },
 *                                 url/storagePath (legacy flat image, read-only compat) }
 *   chartsAuto/{TICKER}-{date}  { ticker, date, auto: { same four keys } }
 * Resolution per timeframe is manual[tf] ?? auto[tf] ?? null — manual always
 * holds primary, and a later manual upload always takes it back.
 * =========================================================================== */

var firebaseConfig = {
  apiKey: "AIzaSyAuYw035-KX31oZfIUMv2U76Ny4J3g_eqA",
  authDomain: "smallcap-heatguage.firebaseapp.com",
  projectId: "smallcap-heatguage",
  storageBucket: "smallcap-heatguage.firebasestorage.app",
  messagingSenderId: "186208427764",
  appId: "1:186208427764:web:c163b07c59c500adf8c8a1"
};

(function () {
  if (typeof firebase === "undefined") {
    console.error("[firebase] SDK did not load — check the gstatic script tags in index.html");
    window.fbReady = false;
    return;
  }
  try {
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    window.firebaseConfig = firebaseConfig;
    window.db = firebase.firestore();
    window.auth = firebase.auth();
    window.storage = firebase.storage();
    window.fbReady = true;
  } catch (e) {
    console.error("[firebase] init failed:", e);
    window.fbReady = false;
  }
})();
