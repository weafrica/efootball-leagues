# Matchday — eFootball Leagues

Real app, connected to your Supabase project, with Google sign-in.

## What's already done
- Database tables + Row Level Security in Supabase
- Google OAuth credentials created and saved in Supabase
- This app's code, ready to deploy

## What's left (do these in order)

### 1. Push this code to GitHub
- Create a new repository on github.com (e.g. `efootball-leagues`)
- Upload all these files into it (GitHub's website lets you drag-and-drop files to upload, no command line needed — use "Add file" → "Upload files")

### 2. Deploy on Vercel
1. Go to vercel.com, sign up/sign in (GitHub login is easiest)
2. "Add New" → "Project" → import the GitHub repo you just created
3. Before clicking Deploy, expand "Environment Variables" and add:
   - `VITE_SUPABASE_URL` = `https://jobgzxljuczzqljwavyq.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = `sb_publishable_rDBySczYcgWx7TT9NbNNLg_jdWRctAZ`
4. Click Deploy. You'll get a live URL like `efootball-leagues.vercel.app`

### 3. Tell Google about your new domain
Google only allows sign-in redirects to URLs you've explicitly listed.
1. Go to console.cloud.google.com → your project → Google Auth Platform → Clients → "Supabase Auth"
2. Under **Authorized JavaScript origins**, add your new Vercel URL, e.g. `https://efootball-leagues.vercel.app`
3. The **Authorized redirect URI** stays as-is (it always points to Supabase, not Vercel) — don't change that one
4. Save

### 4. Make yourself the admin
1. Open your live Vercel URL and sign in with Google (this creates your user account in Supabase)
2. Go to Supabase → SQL Editor and run this (replace the email with the Google account you just signed in with):
```sql
insert into admins (user_id)
select id from auth.users where email = 'your-email@gmail.com';
```
3. Reload your app — leagues you create will now be public to everyone; leagues other users create stay private to them and whoever they invite.

### 5. Turn on the Ladder
A permanent, never-resetting ranking sits in front of the home page and on the sign-in screen — everyone fights for #1, and you can only challenge one of the 3 names directly above you. Beat them and you take their spot.

Deadlines keep things moving: 7 days to accept a ladder challenge or it's an automatic walkover win for the challenger, and 7 days after accepting to log a result or both players drop one spot. (If one side reports a score and the other just won't confirm it, it auto-confirms after 2 days too, so stalling doesn't work as a dodge.)

1. Go to Supabase → SQL Editor
2. Paste in the contents of `supabase/ladder-migration.sql` (in this repo) and run it — safe to run more than once
3. Then paste in `supabase/ladder-deadlines-migration.sql` and run that too
4. That's it — new members are added to the bottom of the ladder automatically when they set up their profile, existing members get slotted in by join date, and deadlines are enforced automatically from here on

### 6. (Optional) Custom domain
In Vercel: Project → Settings → Domains → add your own domain and follow the DNS instructions shown.

## Local testing (optional)
If you ever want to preview changes before deploying:
```
npm install
```
Create a `.env.local` file (copy `.env.example` and rename it) with your real values, then:
```
npm run dev
```
Also add `http://localhost:5173` to Google's Authorized JavaScript origins if you do this, so sign-in works locally too.
