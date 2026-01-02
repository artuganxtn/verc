# Deployment Guide - Render.com (Recommended)

## Why Render?
- ✅ **US IP Address** - Deploy to Oregon/US region for US IP
- ✅ **Better Puppeteer Support** - Docker containers work well with headless browsers
- ✅ **Long-running processes** - No function timeout limits
- ✅ **Free tier available**

## Deployment Steps:

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin YOUR_GITHUB_REPO_URL
git push -u origin main
```

### 2. Deploy on Render
1. Go to https://render.com
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Configure:
   - **Name**: gaming-app (or any name)
   - **Region**: Oregon (US) - **Important for US IP!**
   - **Branch**: main
   - **Root Directory**: (leave empty)
   - **Environment**: Docker
   - **Dockerfile Path**: ./Dockerfile
   - **Docker Context**: (leave empty)
   - **Plan**: Free (or Starter for better performance)

5. **Environment Variables** (optional, set these if needed):
   - `PORT` = 10000 (Render sets this automatically)
   - `EMAIL_USER` = your-email@gmail.com (if you want email notifications)
   - `EMAIL_PASS` = your-app-password (if you want email notifications)

6. Click "Create Web Service"

### 3. Wait for Deployment
- First deployment takes 5-10 minutes (Docker build)
- Subsequent deployments are faster

### 4. Test Your Deployment
Your app will be available at: `https://your-app-name.onrender.com`

Test endpoints:
- `GET https://your-app-name.onrender.com/healthz`
- `POST https://your-app-name.onrender.com/login`
- `POST https://your-app-name.onrender.com/loginsms`

## Important Notes:

1. **US IP**: By selecting Oregon region, your server will have a US IP address
2. **Database**: SQLite file (`gaming.db`) persists in the container's filesystem
3. **Free Tier**: 
   - Service sleeps after 15 minutes of inactivity
   - First request after sleep takes 30-60 seconds (cold start)
   - Consider Starter plan ($7/month) for always-on service

## Alternative: Vercel (Not Recommended)

⚠️ **Vercel is NOT recommended** because:
- Serverless functions have timeout limits (10s free, 60s pro)
- Puppeteer doesn't work well in serverless environment
- Limited memory for headless browsers
- More complex setup required

If you still want to try Vercel, you'd need significant code changes to work within serverless constraints.

