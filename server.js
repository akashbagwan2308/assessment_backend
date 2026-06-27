require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');
const jwt = require('jsonwebtoken'); 

const app = express();

// Security and Middleware
app.use(cors()); 
app.use(express.json({ limit: '20mb' })); // Increased limit for Base64 PDF uploads
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// 🔴 SECRET KEYS & URLS: Store these in Render Environment Variables!
const JWT_SECRET = process.env.JWT_SECRET || "logicsilicon_secure_jwt_key_2024";
const GOOGLE_SCRIPT_URL_LMS = process.env.GOOGLE_SCRIPT_URL_LMS || "https://script.google.com/macros/s/AKfycbzH1O7uFf7KLOTwNoAWyUReCYhiD1dftrUQ-BMok70w2Ry25wD17-oiw0LzyYFTIK4ePQ/exec";
const GOOGLE_SCRIPT_URL_ASSESSMENT = process.env.GOOGLE_SCRIPT_URL_ASSESSMENT || "https://script.google.com/macros/s/AKfycbzhtk4rISUDJvMb3nLzJq2CBY5cVnm9kAnL_fuW77MLOkoR0-_dS0nKtmCwBjpD3mpAnQ/exec";

// ==========================================
// 1. SECURE AUTHENTICATION ENDPOINT
// ==========================================
app.post('/login', async (req, res) => {
    const { email, authString, role } = req.body;

    try {
        // Securely verify credentials with the LMS Google Apps Script
        const googleResponse = await fetch(GOOGLE_SCRIPT_URL_LMS, {
            method: 'POST', 
            headers: {'Content-Type': 'text/plain'}, 
            body: JSON.stringify({ action: 'login', role: role, email: email, authString: authString })
        });

        const data = await googleResponse.json();

        if (data.status === 'success') {
            // Issue the JWT VIP Pass
            const token = jwt.sign(
                { email: email, role: role }, 
                JWT_SECRET, 
                { expiresIn: '24h' }
            );

            res.json({ status: 'success', token: token, user: { email, role }, batch: data.batch });
        } else {
            res.status(401).json({ status: 'error', message: data.message || 'Invalid credentials.' });
        }
    } catch (error) {
        console.error("Auth Error:", error);
        res.status(500).json({ status: 'error', message: 'Internal server error during authentication.' });
    }
});

// ==========================================
// 2. SECURITY MIDDLEWARE (JWT Verification)
// ==========================================
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Extract token from "Bearer <token>"

    if (!token) return res.status(401).json({ status: "error", message: "Access Denied: No JWT Token Provided. Please log in again." });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ status: "error", message: "Access Denied: Invalid or Expired Session Token." });
        req.user = user;
        next();
    });
}

// ==========================================
// 3. GOOGLE SHEETS SECURE PROXIES
// ==========================================
app.post('/api/lms', authenticateToken, async (req, res) => {
    try {
        const response = await fetch(GOOGLE_SCRIPT_URL_LMS, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(req.body)
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error("LMS Proxy Error:", error);
        res.status(502).json({ status: "error", message: "Failed to communicate with LMS Database." });
    }
});

app.post('/api/assessment', authenticateToken, async (req, res) => {
    try {
        const response = await fetch(GOOGLE_SCRIPT_URL_ASSESSMENT, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(req.body)
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error("Assessment Proxy Error:", error);
        res.status(502).json({ status: "error", message: "Failed to communicate with Assessment Database." });
    }
});

// ==========================================
// 4. SECURED COMPILATION ENDPOINT
// ==========================================
app.post('/run', authenticateToken, (req, res) => {
    const code = req.body.code;
    
    if (!code) {
        return res.status(400).json({ error: "No Verilog code provided." });
    }

    const runId = Date.now().toString() + Math.floor(Math.random() * 1000);
    const runDir = path.join('/tmp', runId);
    fs.mkdirSync(runDir, { recursive: true });

    const filePath = path.join(runDir, 'design.sv');
    const outPath = path.join(runDir, 'sim.vvp');

    fs.writeFileSync(filePath, code);

    exec(`iverilog -g2012 -o ${outPath} ${filePath}`, { timeout: 10000 }, (compileErr, compileStdout, compileStderr) => {
        if (compileErr) {
            fs.rmSync(runDir, { recursive: true, force: true });
            return res.json({ status: "error", output: compileStderr || compileErr.message });
        }

        exec(`vvp ${outPath}`, { timeout: 10000 }, (runErr, runStdout, runStderr) => {
            fs.rmSync(runDir, { recursive: true, force: true });

            if (runErr) {
                return res.json({ status: "error", output: runStderr || runErr.message });
            }

            return res.json({ status: "success", output: runStdout });
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Unified Secured Backend running on port ${PORT}`);
});