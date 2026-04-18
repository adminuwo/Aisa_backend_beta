import express from 'express';
import Project from '../models/Project.js';
import { verifyToken } from '../middleware/authorization.js';

const router = express.Router();

// @desc    Create a new project
// @route   POST /api/projects
// @access  Private
router.post('/', verifyToken, async (req, res) => {
    try {
        const { name, clientName, caseSummary, keyIssue, importantDates, isLegalCase } = req.body;
        if (!name) {
            return res.status(400).json({ error: 'Project name is required' });
        }

        const project = new Project({
            name,
            userId: req.user.id,
            clientName: clientName || '',
            caseSummary: caseSummary || '',
            keyIssue: keyIssue || '',
            importantDates: importantDates || [],
            isLegalCase: isLegalCase === undefined ? false : isLegalCase
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
// @desc    Get a specific project
// @route   GET /api/projects/:id
// @access  Private
router.get('/:id', verifyToken, async (req, res) => {
    try {
        const project = await Project.findOne({ _id: req.params.id, userId: req.user.id });
        if (!project) return res.status(404).json({ error: 'Project not found' });
        res.json(project);
    } catch (error) {
        console.error('Error fetching project:', error);
        res.status(500).json({ error: 'Failed to fetch project' });
    }
});

// @desc    Update a project (rename or update case details)
// @route   PUT /api/projects/:id
// @access  Private
router.put('/:id', verifyToken, async (req, res) => {
    try {
        const { name, clientName, caseSummary, keyIssue, importantDates, isLegalCase } = req.body;
        
        const updateData = {};
        if (name !== undefined) updateData.name = name;
        if (clientName !== undefined) updateData.clientName = clientName;
        if (caseSummary !== undefined) updateData.caseSummary = caseSummary;
        if (keyIssue !== undefined) updateData.keyIssue = keyIssue;
        if (importantDates !== undefined) updateData.importantDates = importantDates;
        if (isLegalCase !== undefined) updateData.isLegalCase = isLegalCase;

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

// @desc    Delete a project
// @route   DELETE /api/projects/:id
// @access  Private
router.delete('/:id', verifyToken, async (req, res) => {
    try {
        const project = await Project.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
        if (!project) return res.status(404).json({ error: 'Project not found' });
        // NOTE: Does not currently delete associated chat sessions automatically.
        res.json({ success: true, message: 'Project deleted' });
    } catch (error) {
        console.error('Error deleting project:', error);
        res.status(500).json({ error: 'Failed to delete project' });
    }
});

export default router;
