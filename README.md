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

### 5. (Optional) Custom domain
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
