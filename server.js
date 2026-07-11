require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');
const jwt = require('jsonwebtoken'); 
const { GoogleGenerativeAI } = require('@google/generative-ai'); // <-- Using the stable SDK

const app = express();

// Security and Middleware
app.use(cors()); 
app.use(express.json({ limit: '20mb' })); 
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// 🔴 SECRET KEYS & URLS
const JWT_SECRET = process.env.JWT_SECRET || "logicsilicon_secure_jwt_key_2024";
const GOOGLE_SCRIPT_URL_LMS = process.env.GOOGLE_SCRIPT_URL_LMS || "https://script.google.com/macros/s/AKfycbzH1O7uFf7KLOTwNoAWyUReCYhiD1dftrUQ-BMok70w2Ry25wD17-oiw0LzyYFTIK4ePQ/exec";
const GOOGLE_SCRIPT_URL_ASSESSMENT = process.env.GOOGLE_SCRIPT_URL_ASSESSMENT || "https://script.google.com/macros/s/AKfycbzhtk4rISUDJvMb3nLzJq2CBY5cVnm9kAnL_fuW77MLOkoR0-_dS0nKtmCwBjpD3mpAnQ/exec";

// Initialize the Stable AI Engine
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ==========================================
// 1. SECURE AUTHENTICATION ENDPOINT
// ==========================================
app.post('/login', async (req, res) => {
    const { email, authString, role } = req.body;

    try {
        const googleResponse = await fetch(GOOGLE_SCRIPT_URL_LMS, {
            method: 'POST', 
            headers: {'Content-Type': 'text/plain'}, 
            body: JSON.stringify({ action: 'login', role: role, email: email, authString: authString })
        });

        const data = await googleResponse.json();

        if (data.status === 'success') {
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
    const token = authHeader && authHeader.split(' ')[1];

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

// ==========================================
// 5. SECURED AI GRADING ENDPOINT
// ==========================================
app.post('/ai-grade', authenticateToken, async (req, res) => {
    try {
        if (!process.env.GEMINI_API_KEY) {
            return res.status(500).json({ 
                status: 'error', 
                message: 'Server configuration error: AI API key is missing from Render dashboard.' 
            });
        }

        const { questionTitle, questionDesc, studentCode, maxMarks } = req.body;

        if (!studentCode || studentCode.trim() === "") {
            return res.json({ status: 'success', suggestedMarks: 0, feedback: "Not attempted. No code provided." });
        }

        const systemPrompt = `
You are an expert Hardware Engineering Instructor grading a student's Verilog/SystemVerilog code. 

Context:
- Question Title: ${questionTitle}
- Question Description: ${questionDesc}
- Maximum Marks: ${maxMarks}

Student Code Submission:
${studentCode}

Evaluate the code strictly based on the following rules:
1. NOT ATTEMPTED: If the code is missing, or is just an empty module/boilerplate with no logic implemented, score 0 marks. Reason: "Not attempted / No logic implemented."
2. SYNTAX: Check for valid Verilog/SystemVerilog syntax. Deduct marks for syntax errors and clearly list them.
3. LOGIC: Verify if the implemented logic correctly solves the problem described. Deduct marks for flawed logic, incorrect port mappings, or missing edge cases.
4. Provide a final numerical score (integer) based on the Maximum Marks.

Respond STRICTLY with raw JSON only. Do NOT wrap the JSON in markdown code blocks. Use this exact schema:
{
  "suggestedMarks": 0,
  "feedback": "Your concise 2-4 sentence explanation here."
}`;

        // Using the stable SDK initialization
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: { responseMimeType: "application/json" }
        });

        const result = await model.generateContent(systemPrompt);
        const responseText = result.response.text();

        if (!responseText) {
            throw new Error("AI returned empty content. The code may have triggered a safety filter.");
        }

        // Strip any residual markdown that the AI might incorrectly include
        let cleanText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();

        let aiResult;
        try {
            aiResult = JSON.parse(cleanText);
        } catch (parseErr) {
            console.error("Raw AI Output was:", responseText);
            throw new Error("AI returned malformed JSON data that could not be parsed.");
        }

        res.json({
            status: 'success',
            suggestedMarks: aiResult.suggestedMarks,
            feedback: aiResult.feedback
        });

    } catch (error) {
        console.error("AI Grading Error:", error);
        
        res.status(500).json({ 
            status: 'error', 
            message: `AI Engine Error: ${error.message}` 
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Unified Secured Backend running on port ${PORT}`);
});
