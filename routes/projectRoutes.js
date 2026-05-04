import express from 'express';
import Project from '../models/Project.js';
import { verifyToken } from '../middleware/authorization.js';
import * as legalIntelligenceService from '../Tools/AI_Legal/services/legalIntelligence.service.js';

const router = express.Router();

// @desc    Create a new project
// @route   POST /api/projects
// @access  Private
router.post('/', verifyToken, async (req, res) => {
    try {
        const { 
            name, clientName, summary, keyIssue, importantDates, isLegalCase, 
            caseType, accused, status, stage, priority, opponentName, lawyers, 
            facts, legalIssues, reliefGoals, intelligence, tasks, communicationLogs, research, hearings
        } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Project name is required' });
        }

        const project = new Project({
            name,
            userId: req.user.id,
            clientName: clientName || '',
            summary: summary || '',
            caseType: caseType || '',
            status: status || 'Active',
            stage: stage || 'Pre-litigation',
            priority: priority || 'Medium',
            opponentName: opponentName || accused || '',
            lawyers: lawyers || [],
            facts: facts || [],
            legalIssues: legalIssues || (keyIssue ? [keyIssue] : []),
            reliefGoals: reliefGoals || '',
            intelligence: intelligence || { strengthScore: 0, winProbability: 0, riskLevel: 'Medium' },
            tasks: tasks || [],
            communicationLogs: communicationLogs || [],
            research: research || [],
            isLegalCase: isLegalCase === undefined ? false : isLegalCase,
            accused: accused || '',
            keyIssue: keyIssue || '',
            importantDates: importantDates || [],
            hearings: hearings || [],
            evidence: req.body.evidence || [],
            savedPrecedents: req.body.savedPrecedents || []
        });

        await project.save();
        res.status(201).json(project);
    } catch (error) {
        console.error('Error creating project:', error);
        res.status(500).json({ error: 'Failed to create project' });
    }
});

// @desc    Get all user projects
// @route   GET /api/projects
// @access  Private
router.get('/', verifyToken, async (req, res) => {
    try {
        const projects = await Project.find({ userId: req.user.id }).sort({ createdAt: -1 });
        res.json(projects);
    } catch (error) {
        console.error('Error fetching projects:', error);
        res.status(500).json({ error: 'Failed to fetch projects' });
    }
});

// @route   GET /api/projects/:id
// @access  Private
router.get('/:id', verifyToken, async (req, res) => {
    try {
        console.log(`[DEBUG] Fetching project: ${req.params.id} for user: ${req.user.id}`);
        const project = await Project.findOne({ _id: req.params.id, userId: req.user.id });
        if (!project) {
            console.warn(`[DEBUG] Project NOT FOUND: ${req.params.id} for user: ${req.user.id}`);
            return res.status(404).json({ error: 'Project not found' });
        }
        res.json(project);
    } catch (error) {
        console.error('Error fetching project:', error);
        res.status(500).json({ error: 'Failed to fetch project', details: error.message });
    }
});

// @desc    Update a project
// @route   PUT /api/projects/:id
// @access  Private
router.put('/:id', verifyToken, async (req, res) => {
    try {
        const updateData = req.body;
        
        // Ensure userId cannot be changed via update
        delete updateData.userId;
        delete updateData._id;

        const project = await Project.findOneAndUpdate(
            { _id: req.params.id, userId: req.user.id },
            { $set: updateData },
            { new: true }
        );

        if (!project) return res.status(404).json({ error: 'Project not found' });
        res.json(project);
    } catch (error) {
        console.error('Error updating project:', error);
        res.status(500).json({ error: 'Failed to update project', details: error.message });
    }
});

// Shared analysis handler to keep code DRY and consistent
const performCaseAnalysis = async (req, res) => {
    try {
        const { rawText } = req.body;
        const project = await Project.findOne({ _id: req.params.id, userId: req.user.id });
        
        if (!project) {
            return res.status(404).json({ error: 'Case not found' });
        }

        const inputText = rawText || project.summary || project.name;
        const aiResponse = await legalIntelligenceService.analyzeCaseDetails(inputText, project);
        
        const aiData = typeof aiResponse === "string" ? JSON.parse(aiResponse) : aiResponse;

        // Sanitization helpers
        const toStr = (val, fallback = '') => {
            if (!val) return fallback;
            if (typeof val === 'string') return val;
            return JSON.stringify(val);
        };

        const toDate = (val) => {
            if (!val) return null;
            const d = new Date(val);
            return isNaN(d.getTime()) ? null : d;
        };

        // Map AI keys to normalized local keys with safety checks
        const normalized = {
            summary: toStr(aiData.executive_summary || aiData.summary),
            strength: aiData.case_strength ?? aiData.strengthScore ?? aiData.strength ?? 0,
            probability: aiData.win_probability ?? aiData.winProbability ?? aiData.probability ?? 0,
            timeline: Array.isArray(aiData.timeline) ? aiData.timeline : [],
            evidence: Array.isArray(aiData.evidence) ? aiData.evidence : [],
            research: Array.isArray(aiData.legal_research || aiData.research) ? (aiData.legal_research || aiData.research) : [],
            steps: Array.isArray(aiData.process_steps || aiData.steps) ? (aiData.process_steps || aiData.steps) : [],
            risk: aiData.risk_assessment || aiData.risk || {},
            vulnerabilities: Array.isArray(aiData.critical_vulnerabilities || aiData.weakPoints) ? (aiData.critical_vulnerabilities || aiData.weakPoints) : [],
            opponent: Array.isArray(aiData.opponent_strategy || aiData.opponentStrategies) ? (aiData.opponent_strategy || aiData.opponent_strategies) : [],
            relief: toStr(aiData.primary_relief || aiData.reliefGoals),
            strategy: Array.isArray(aiData.strategy_recommendation || aiData.strategyRecommendations) ? (aiData.strategy_recommendation || aiData.strategyRecommendations) : []
        };

        const updateData = {
            summary: normalized.summary || project.summary,
            clientName: project.clientName || toStr(aiData.parties?.plaintiff?.name || aiData.parties?.plaintiff) || '',
            opponentName: project.opponentName || toStr(aiData.parties?.defendant?.name || aiData.parties?.defendant) || '',
            reliefGoals: normalized.relief || project.reliefGoals,
            intelligence: {
                strengthScore: Number(normalized.strength) || 0,
                winProbability: Number(normalized.probability) || 0,
                riskLevel: ['Low', 'Medium', 'High', 'Critical'].includes(normalized.risk?.level) ? normalized.risk.level : 'Medium',
                weakPoints: [...(normalized.vulnerabilities || []), normalized.risk?.reason].filter(Boolean).map(v => toStr(v)),
                opponentStrategies: normalized.opponent.map(s => toStr(s)),
                strategyRecommendations: normalized.strategy.map(s => toStr(s)),
                missingEvidence: []
            },
            facts: [
                ...(project.facts || []),
                ...normalized.timeline
                    .filter(f => f && (f.event || f.title))
                    .filter(f => !(project.facts || []).some(fx => fx.event === (f.event || f.title)))
                    .map(f => ({
                        date: toDate(f.date),
                        event: toStr(f.event || f.title),
                        description: toStr(f.description || f.event || f.title)
                    }))
            ],
            legalIssues: normalized.research.map(r => toStr(r.law || r.lawName)).filter(Boolean),
            tasks: [
                ...(project.tasks || []),
                ...normalized.steps
                    .filter(p => p && (p.step || p.title))
                    .filter(p => !(project.tasks || []).some(tx => tx.title === (p.step || p.title)))
                    .map(p => ({
                        title: toStr(p.step || p.title),
                        status: 'Pending',
                        priority: toStr(p.priority) || 'Medium'
                    }))
            ],
            evidence: [
                ...(project.evidence || []),
                ...normalized.evidence
                    .filter(e => e && (e.title || e.name || e.description))
                    .filter(e => !(project.evidence || []).some(ex => ex.name === (e.title || e.name || e.description)))
                    .map(e => ({
                        name: toStr(e.title || e.name || e.description),
                        type: toStr(e.type) || 'Document',
                        status: toStr(e.strength) || 'Moderate',
                        uploadDate: new Date()
                    }))
            ],
            research: [
                ...(project.research || []),
                ...normalized.research
                    .filter(r => r && (r.law || r.lawName))
                    .filter(r => !(project.research || []).some(rx => rx.lawName === (r.law || r.lawName) && rx.section === (r.section || '')))
                    .map(r => ({
                        lawName: toStr(r.law || r.lawName),
                        section: toStr(r.section),
                        description: toStr(r.description)
                    }))
            ]
        };

        const updatedProject = await Project.findOneAndUpdate(
            { _id: req.params.id, userId: req.user.id },
            { $set: updateData },
            { new: true }
        );

        res.json(updatedProject);
    } catch (error) {
        console.error('[CaseAnalysis] Error:', error.message);
        res.status(500).json({ error: 'Failed to analyze case', details: error.message });
    }
};

// @desc    Analyze case details and update project
// @route   POST /api/projects/:id/analyze
router.post('/:id/analyze', verifyToken, performCaseAnalysis);

// @desc    Auto-Analyze alias — POST /api/cases/:id/auto-analyze
router.post('/:id/auto-analyze', verifyToken, performCaseAnalysis);


// @desc    Delete a project
// @route   DELETE /api/projects/:id
// @access  Private
router.delete('/:id', verifyToken, async (req, res) => {
    try {
        const project = await Project.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
        if (!project) return res.status(404).json({ error: 'Project not found' });
        res.json({ success: true, message: 'Project deleted' });
    } catch (error) {
        console.error('Error deleting project:', error);
        res.status(500).json({ error: 'Failed to delete project' });
    }
});

export default router;
