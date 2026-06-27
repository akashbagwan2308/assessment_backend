const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');
const jwt = require('jsonwebtoken'); // Added JWT

const app = express();
app.use(cors()); // Allows your GitHub Pages site to talk to this server
app.use(express.json());

// 🔴 SECRET KEY: Store this in Render Environment Variables!
const JWT_SECRET = process.env.JWT_SECRET || "logicsilicon_secure_jwt_key_2024";
const GOOGLE_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbzhtk4rISUDJvMb3nLzJq2CBY5cVnm9kAnL_fuW77MLOkoR0-_dS0nKtmCwBjpD3mpAnQ/exec";

// ==========================================
// 1. SECURE AUTHENTICATION ENDPOINT
// ==========================================
app.post('/login', async (req, res) => {
    const { email, authString, role } = req.body;

    try {
        // Securely verify credentials with Google Apps Script from the backend
        const googleResponse = await fetch(GOOGLE_WEB_APP_URL, {
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

            res.json({ status: 'success', token: token, user: { email, role } });
        } else {
            res.status(401).json({ status: 'error', message: data.message || 'Invalid credentials.' });
        }
    } catch (error) {
        console.error("Auth Error:", error);
        res.status(500).json({ status: 'error', message: 'Internal server error during authentication.' });
    }
});

// ==========================================
// 2. SECURITY MIDDLEWARE
// ==========================================
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Extract token from "Bearer <token>"

    if (!token) return res.status(401).json({ status: "error", output: "Access Denied: No JWT Token Provided. Please log in again." });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ status: "error", output: "Access Denied: Invalid or Expired Session Token." });
        req.user = user;
        next();
    });
}

// ==========================================
// 3. SECURED COMPILATION ENDPOINT
// ==========================================
// Added 'authenticateToken' to protect execution
app.post('/run', authenticateToken, (req, res) => {
    const code = req.body.code;
    
    if (!code) {
        return res.status(400).json({ error: "No Verilog code provided." });
    }

    // Create a unique temporary directory for this student's execution
    const runId = Date.now().toString() + Math.floor(Math.random() * 1000);
    const runDir = path.join('/tmp', runId);
    fs.mkdirSync(runDir, { recursive: true });

    // IMPORTANT: Save as .sv so the compiler natively treats it as SystemVerilog
    const filePath = path.join(runDir, 'design.sv');
    const outPath = path.join(runDir, 'sim.vvp');

    // 1. Save the student's code to a file
    fs.writeFileSync(filePath, code);

    // 2. Compile the code using Icarus Verilog with SystemVerilog support (-g2012)
    exec(`iverilog -g2012 -o ${outPath} ${filePath}`, { timeout: 10000 }, (compileErr, compileStdout, compileStderr) => {
        if (compileErr) {
            // If there's a syntax error, send it back!
            fs.rmSync(runDir, { recursive: true, force: true });
            return res.json({ status: "error", output: compileStderr || compileErr.message });
        }

        // 3. Run the simulation using VVP
        exec(`vvp ${outPath}`, { timeout: 10000 }, (runErr, runStdout, runStderr) => {
            // Clean up the temporary files so we don't run out of space
            fs.rmSync(runDir, { recursive: true, force: true });

            if (runErr) {
                return res.json({ status: "error", output: runStderr || runErr.message });
            }

            // Send the terminal output back to the student's screen!
            return res.json({ status: "success", output: runStdout });
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Secured SystemVerilog Compilation Server running on port ${PORT}`);
});