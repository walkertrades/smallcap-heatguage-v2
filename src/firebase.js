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
 * !! ACTION REQUIRED — the username / profile-picture feature is BLOCKED until
 * !! both rulesets below are re-published. Measured 2026-07-27, all four of the
 * !! operations it needs currently return PERMISSION_DENIED:
 * !!    · unauthenticated get of usernames/{name}  (signup availability check)
 * !!    · authenticated create of usernames/{name} (reserving the handle)
 * !!    · authenticated read of another users/{uid} (avatars in the notes feed)
 * !!    · Storage write to avatars/                (profile pictures)
 * !! Until then the app degrades: accounts still create and the username is
 * !! stored on the profile, but uniqueness is NOT enforced, avatars fall back to
 * !! generated letter circles, and other people's handles show from the copy
 * !! saved on each note rather than live.
 * ===========================================================================
 *
 * RULES STATE, measured 2026-07-27:
 *   Firestore — published and enforcing (verified: one account cannot delete
 *     another's note). Needs the two NEW blocks below.
 *   Storage   — now published and enforcing too (an avatars/ write returned 403
 *     where it previously succeeded). Needs the new avatars/ block below.
 *
 * STEP 1 — Firebase Console -> Firestore Database -> Rules tab -> paste -> Publish
 *
 *   rules_version = '2';
 *   service cloud.firestore {
 *     match /databases/{database}/documents {
 *       match /users/{uid} {
 *         // READ is open to any signed-in user so the notes feed can render
 *         // live avatars and handles. Writes stay owner-only. Profile docs hold
 *         // username / fullName / photoURL / email — nothing secret, but note
 *         // that email is visible to signed-in users under this rule.
 *         allow read:  if request.auth != null;
 *         allow write: if request.auth != null && request.auth.uid == uid;
 *       }
 *
 *       // Username reservations: one doc per lowercased handle, { uid, username }.
 *       // `get` is public because availability has to be checked DURING signup,
 *       // before the account exists. `list` stays closed so the full handle
 *       // directory can't be enumerated.
 *       match /usernames/{name} {
 *         allow get:    if true;
 *         allow list:   if false;
 *         allow create: if request.auth != null
 *                       && request.resource.data.uid == request.auth.uid;
 *         allow delete: if request.auth != null
 *                       && resource.data.uid == request.auth.uid;
 *         allow update: if false;
 *       }
 *
 *       match /charts/{chartId} {
 *         allow read:   if request.auth != null;
 *         allow create: if request.auth != null;
 *         // any signed-in user may REPLACE a chart (re-upload wins, as specced),
 *         // but only the uploader may DELETE it
 *         allow update: if request.auth != null;
 *         allow delete: if request.auth != null
 *                       && resource.data.uploaderUid == request.auth.uid;
 *       }
 *       match /notes/{noteId}/comments/{commentId} {
 *         allow read:   if request.auth != null;
 *         allow create: if request.auth != null;
 *         allow delete: if request.auth != null
 *                       && request.auth.uid == resource.data.authorUid;
 *       }
 *     }
 *   }
 *
 * STEP 2 — Firebase Console -> Storage -> Rules tab -> paste -> Publish
 * Storage is a SEPARATE ruleset from Firestore.
 *
 *   rules_version = '2';
 *   service firebase.storage {
 *     match /b/{bucket}/o {
 *       match /charts/{fileName} {
 *         allow read: if request.auth != null;
 *         allow write: if request.auth != null
 *                      && request.resource.size < 10 * 1024 * 1024
 *                      && request.resource.contentType.matches('image/.*');
 *       }
 *       // avatars/{uid}.jpg — only the owner may write their own file
 *       match /avatars/{fileName} {
 *         allow read: if request.auth != null;
 *         allow write: if request.auth != null
 *                      && fileName.matches(request.auth.uid + '[.].*')
 *                      && request.resource.size < 2 * 1024 * 1024
 *                      && request.resource.contentType.matches('image/.*');
 *       }
 *     }
 *   }
 *
 * Deliberate changes from the rules as originally handed over:
 *   1. `users`  — added `request.auth != null &&`, and split read from write so
 *      signed-in users can render each other's avatars.
 *   2. `charts` — the original allowed ANY signed-in user to delete ANY chart,
 *      contradicting "don't let users delete each other's charts". Split into
 *      update (anyone, so re-upload still wins) vs delete (owner only).
 *   3. `usernames` — new, required for unique-handle enforcement.
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
