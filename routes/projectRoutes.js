import express from 'express';
import Project from '../models/Project.js';
import { verifyToken } from '../middleware/authorization.js';
import * as legalIntelligenceService from '../services/legalIntelligence.service.js';

const router = express.Router();

// @desc    Create a new project
// @route   POST /api/projects
// @access  Private
router.post('/', verifyToken, async (req, res) => {
    try {
        const { 
            name, clientName, caseSummary, keyIssue, importantDates, isLegalCase, 
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
            caseSummary: caseSummary || '',
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
            hearings: hearings || []
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
        res.status(500).json({ error: 'Failed to fetch project' });
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
        res.status(500).json({ error: 'Failed to update project' });
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

        const inputText = rawText || project.caseSummary || project.name;
        const aiResponse = await legalIntelligenceService.analyzeCaseDetails(inputText, project);
        
        const aiData = typeof aiResponse === "string" ? JSON.parse(aiResponse) : aiResponse;

        // Map AI keys to normalized local keys
        const normalized = {
            summary: aiData.executive_summary || aiData.summary,
            strength: aiData.case_strength ?? aiData.strengthScore ?? aiData.strength ?? 0,
            probability: aiData.win_probability ?? aiData.winProbability ?? aiData.probability ?? 0,
            timeline: aiData.timeline || [],
            evidence: aiData.evidence || [],
            research: aiData.legal_research || aiData.research || [],
            steps: aiData.process_steps || aiData.steps || [],
            risk: aiData.risk_assessment || aiData.risk || {},
            vulnerabilities: aiData.critical_vulnerabilities || aiData.weakPoints || [],
            opponent: aiData.opponent_strategy || aiData.opponentStrategies || [],
            relief: aiData.primary_relief || aiData.reliefGoals || "",
            strategy: aiData.strategy_recommendation || aiData.strategyRecommendations || []
        };

        const updateData = {
            caseSummary: normalized.summary || project.caseSummary,
            clientName: project.clientName || aiData.parties?.plaintiff?.name || '',
            opponentName: project.opponentName || aiData.parties?.defendant?.name || '',
            reliefGoals: normalized.relief || project.reliefGoals,
            intelligence: {
                strengthScore: normalized.strength,
                winProbability: normalized.probability,
                riskLevel: normalized.risk?.level || 'Medium',
                weakPoints: [...(normalized.vulnerabilities || []), normalized.risk?.reason].filter(Boolean),
                opponentStrategies: normalized.opponent || [],
                strategyRecommendations: normalized.strategy || [],
                missingEvidence: []
            },
            facts: normalized.timeline.map(f => ({
                date: f.date ? new Date(f.date) : null,
                event: f.event || f.title,
                description: f.description || f.event || f.title
            })),
            legalIssues: normalized.research.map(r => r.law || r.lawName),
            tasks: normalized.steps.map(p => ({
                title: p.step || p.title,
                status: 'Pending',
                priority: p.priority || 'Medium'
            })),
            evidence: normalized.evidence.map(e => ({
                name: e.title || e.name || e.description,
                type: e.type || 'Document',
                status: e.strength || 'Moderate',
                uploadDate: new Date()
            })),
            research: normalized.research.map(r => ({
                lawName: r.law || r.lawName,
                section: r.section || '',
                description: r.description
            }))
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
