require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');
const jwt = require('jsonwebtoken'); 
const { OpenAI } = require('openai'); // <-- Switched to OpenAI

const app = express();

// Security and Middleware
app.use(cors()); 
app.use(express.json({ limit: '20mb' })); 
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// 🔴 SECRET KEYS & URLS
const JWT_SECRET = process.env.JWT_SECRET || "logicsilicon_secure_jwt_key_2024";
const GOOGLE_SCRIPT_URL_LMS = process.env.GOOGLE_SCRIPT_URL_LMS || "https://script.google.com/macros/s/AKfycbzH1O7uFf7KLOTwNoAWyUReCYhiD1dftrUQ-BMok70w2Ry25wD17-oiw0LzyYFTIK4ePQ/exec";
const GOOGLE_SCRIPT_URL_ASSESSMENT = process.env.GOOGLE_SCRIPT_URL_ASSESSMENT || "https://script.google.com/macros/s/AKfycbzhtk4rISUDJvMb3nLzJq2CBY5cVnm9kAnL_fuW77MLOkoR0-_dS0nKtmCwBjpD3mpAnQ/exec";

// Initialize OpenAI
// Initialize OpenAI SDK to point to Groq's free servers
const openai = new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: "https://api.groq.com/openai/v1" 
});

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
// 5. SECURED AI GRADING ENDPOINT (OpenAI)
// ==========================================
app.post('/ai-grade', authenticateToken, async (req, res) => {
    try {
        if (!process.env.OPENAI_API_KEY) {
            return res.status(500).json({ 
                status: 'error', 
                message: 'Server configuration error: OPENAI_API_KEY is missing from Render dashboard.' 
            });
        }

        const { questionTitle, questionDesc, studentCode, maxMarks } = req.body;

        if (!studentCode || studentCode.trim() === "") {
            return res.json({ status: 'success', suggestedMarks: 0, feedback: "Not attempted. No code provided." });
        }

        const systemPrompt = `
You are a strict Verilog/SystemVerilog compiler and expert hardware engineering instructor.

Context:
- Question Title: ${questionTitle}
- Question Description: ${questionDesc}
- Maximum Marks: ${maxMarks}

Student Code Submission:
${studentCode}

EVALUATION RULES:
1. Act as a strict compiler. Line 1 checks: Does the module declaration have a port list? (e.g., 'module name;' is a syntax error if instantiated later with ports).
2. Variable checks: Are all variables declared before use? (e.g., using 'A' instead of 'data').
3. Completeness: Did they include all required blocks, $monitor statements, and $time variables?

You MUST respond with raw, valid JSON only. Do not wrap it in markdown blocks. Use this EXACT schema:
{
  "compiler_analysis": "<Analyze the code line-by-line here first. Look specifically for missing port lists, missing semicolons, and undeclared variables before grading.>",
  "suggestedMarks": <number>,
  "feedback": "• [Exact Code Snippet] -> [Direct, specific issue]\\n• [Exact Code Snippet] -> [Direct, specific issue]"
}

FEEDBACK FORMATTING RULES (STRICT):
- The feedback string MUST be a direct bulleted list using the '•' symbol and '\\n' for line breaks.
- NEVER write introductory paragraphs. Start immediately with the first bullet point.
- Format strictly as: "• [Code] -> [Error]".
- Example 1: "• module pallindrome_checker; -> Syntax Error: Missing port list (data, p) in module declaration."
- Example 2: "• assign p = (A[7]==A[0])... -> Logic Error: Variable 'A' is undeclared. The input is named 'data'."
- Example 3: "• $monitor(...) -> Syntax Error: $time argument is missing."`;

        
        // Call OpenAI API
        // Call API
        const completion = await openai.chat.completions.create({
            model: "openai/gpt-oss-120b", // <-- The active, supported Groq model
            messages: [
                { 
                    role: "system", 
                    content: "You are an expert Hardware Engineering Instructor grading a student's Verilog/SystemVerilog code. You output strictly valid JSON." 
                },
                { 
                    role: "user", 
                    content: systemPrompt 
                }
            ],
            response_format: { type: "json_object" } 
        });

        const responseText = completion.choices[0].message.content;

        let aiResult;
        try {
            aiResult = JSON.parse(responseText);
        } catch (parseErr) {
            console.error("Raw AI Output was:", responseText);
            throw new Error("AI returned malformed JSON data that could not be parsed.");
        }

        res.json({
            status: 'success',
            suggestedMarks: aiResult.suggestedMarks || 0,
            feedback: aiResult.feedback || "Evaluation complete."
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
