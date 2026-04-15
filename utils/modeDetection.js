/**
 * Mode Detection Utility for AISA™
 * Automatically detects the appropriate mode based on user input and context
 */

const MODES = {
  NORMAL_CHAT: 'NORMAL_CHAT',
  FILE_ANALYSIS: 'FILE_ANALYSIS',
  FILE_CONVERSION: 'FILE_CONVERSION',
  CONTENT_WRITING: 'CONTENT_WRITING',
  CODING_HELP: 'CODING_HELP',
  TASK_ASSISTANT: 'TASK_ASSISTANT',
  DEEP_SEARCH: 'DEEP_SEARCH',
  IMAGE_EDIT: 'IMAGE_EDIT',
  WEB_SEARCH: 'web_search'
};

const EDIT_KEYWORDS = [
  'edit', 'modify', 'change', 'remove', 'add', 'background', 'enhance', 'remix', 'clean up',
  'background remove', 'bg remove', 'remix this', 'enhance this', 'is image me', 'is photo me',
  'badal do', 'hata do', 'saaf kar do'
];

const CODING_KEYWORDS = [
  'code', 'function', 'class', 'debug', 'error', 'bug', 'programming',
  'javascript', 'python', 'java', 'react', 'node', 'api', 'algorithm',
  'syntax', 'compile', 'runtime', 'variable', 'loop', 'array', 'object',
  'database', 'sql', 'html', 'css', 'typescript', 'component', 'import',
  'export', 'async', 'await', 'promise', 'callback', 'fix this code',
  'write a function', 'create a script', 'implement', 'refactor'
];

const WRITING_KEYWORDS = [
  'write', 'article', 'blog', 'essay', 'content', 'draft', 'compose',
  'create a post', 'write about', 'paragraph', 'story', 'letter',
  'email template', 'description', 'summary', 'report', 'document',
  'copywriting', 'marketing copy', 'social media post', 'caption',
  'headline', 'slogan', 'tagline', 'press release'
];

const TASK_KEYWORDS = [
  'task', 'todo', 'plan', 'schedule', 'organize', 'goal', 'objective',
  'steps', 'how to', 'guide me', 'help me plan', 'breakdown', 'roadmap',
  'timeline', 'priority', 'checklist', 'action items', 'strategy',
  'project plan', 'workflow', 'process', 'milestone'
];

const CONVERSION_KEYWORDS = [
  'convert', 'change format', 'make it', 'turn into', 'transform',
  'pdf to word', 'word to pdf', 'pdf to doc', 'doc to pdf', 'docx to pdf',
  'pdf to docx', 'convert karo', 'badlo', 'format change', 'file convert',
  'is file ko', 'convert this', 'make this a', 'change this to',
  'into pdf', 'to pdf', 'into word', 'to word', 'into doc', 'to doc',
  'me convert', 'pdf me', 'word me', 'doc me'
];

/**
 * Detect mode based on user message and attachments
 * @param {string} message - User's message content
 * @param {Array} attachments - Array of attachment objects
 * @returns {string} - Detected mode
 */
export function detectMode(message = '', attachments = []) {
  const lowerMessage = message.toLowerCase().trim();
  const hasAttachments = attachments && attachments.length > 0;

  console.log(`[MODE DETECTION] Processing message: "${lowerMessage}" with ${attachments ? attachments.length : 0} attachments`);

  // Priority 1: File Analysis - IF explicitly not a conversion or edit (restricted to cards)
  if (hasAttachments) {
    console.log(`[MODE DETECTION] File detected. Defaulting to FILE_ANALYSIS.`);
    return MODES.FILE_ANALYSIS;
  }

  // Priority 2: Coding Help - check for code-related keywords
  const hasCodingKeywords = CODING_KEYWORDS.some(keyword =>
    lowerMessage.includes(keyword)
  );

  // Check for code blocks or code-like patterns
  const hasCodePattern = /```|function\s*\(|const\s+\w+\s*=|class\s+\w+|import\s+.*from|<\w+>|{\s*\w+:|\/\/|\/\*/.test(message);

  if (hasCodingKeywords || hasCodePattern) {
    return MODES.CODING_HELP;
  }

  // Priority 3: Content Writing - check for writing-related keywords
  const hasWritingKeywords = WRITING_KEYWORDS.some(keyword =>
    lowerMessage.includes(keyword)
  );

  if (hasWritingKeywords) {
    return MODES.CONTENT_WRITING;
  }

  // Priority 4: Task Assistant - check for task-related keywords
  const hasTaskKeywords = TASK_KEYWORDS.some(keyword =>
    lowerMessage.includes(keyword)
  );

  if (hasTaskKeywords) {
    return MODES.TASK_ASSISTANT;
  }

  // Default: Normal Chat
  return MODES.NORMAL_CHAT;
}

import { getConfig } from '../services/configService.js';

/**
 * Get mode-specific system instruction
 * @param {string} mode - Detected mode
 * @param {string} language - User's preferred language
 * @param {object} context - Additional context (agent info, etc.)
 * @returns {string} - System instruction for the mode
 */
export function getModeSystemInstruction(mode, language = 'English', context = {}) {
  const { agentName = 'AISA', agentCategory = 'General', fileCount = 0 } = context;

  const baseIdentity = `You are ${agentName}, powered by UWO (Unified Web Options & Services Pvt. Ltd.) — an IT-registered technology company founded in 2020 and headquartered in Jabalpur, Madhya Pradesh.
UWO specializes in AI solutions, business automation, and flagship project AI Mall™ (a global AI marketplace and automation ecosystem).
Mission: To make AI simple, practical, and human-aligned.`;

  const languageRule = `\n\nCRITICAL LANGUAGE RULE:\nALWAYS respond in the SAME LANGUAGE and SCRIPT as the user's message.\n- If user writes in HINGLISH (Roman script Hindi), respond in HINGLISH.\n- If user writes in HINDI script (Devanagari), respond in HINDI script.\n- If user writes in ENGLISH, respond in ENGLISH.`;

  switch (mode) {
    case MODES.FILE_ANALYSIS:
      const analysisInstruct = getConfig('MODE_FILE_ANALYSIS_INSTRUCTION', `MODE: FILE_ANALYSIS - Document Intelligence. ANALYZE THE ATTACHED FILES.`);
      return `${baseIdentity}\n\n${analysisInstruct}\n\n${fileCount > 1 ? `\nMULTI-FILE ANALYSIS (${fileCount} files):
You MUST provide ${fileCount} distinct analysis blocks.
Use "---SPLIT_RESPONSE---" delimiter between each file's analysis.` : ''}`;

    case MODES.FILE_CONVERSION:
      const conversionInstruct = getConfig('MODE_FILE_CONVERSION_INSTRUCTION', `MODE: FILE_CONVERSION. OUTPUT JSON ONLY.`);
      return `${baseIdentity}\n\n${conversionInstruct}`;

    case MODES.CONTENT_WRITING:
      const writingInstruct = getConfig('MODE_CONTENT_WRITING_INSTRUCTION', `MODE: CONTENT_WRITING. You are a professional writer.`);
      return `${baseIdentity}\n\n${writingInstruct}${languageRule}`;

    case MODES.CODING_HELP:
      const codingInstruct = getConfig('MODE_CODING_HELP_INSTRUCTION', `MODE: CODING_HELP. You are a senior software engineer.`);
      return `${baseIdentity}\n\n${codingInstruct}${languageRule}`;

    case MODES.TASK_ASSISTANT:
      const taskInstruct = getConfig('MODE_TASK_ASSISTANT_INSTRUCTION', `MODE: TASK_ASSISTANT. You are a productivity expert.`);
      return `${baseIdentity}\n\n${taskInstruct}${languageRule}`;

    case MODES.NORMAL_CHAT:
    default:
      const chatInstruct = getConfig('AISA_CONVERSATIONAL_RULES', `You are a friendly, intelligent conversational assistant for AISA™.`);
      return `${baseIdentity}\n\n${chatInstruct}${languageRule}`;
  }
}

/**
 * Get mode display name for UI
 * @param {string} mode - Mode constant
 * @returns {string} - Human-readable mode name
 */
export function getModeName(mode) {
  const names = {
    [MODES.NORMAL_CHAT]: 'Chat',
    [MODES.FILE_ANALYSIS]: 'File Analysis',
    [MODES.FILE_CONVERSION]: 'File Conversion',
    [MODES.CONTENT_WRITING]: 'Content Writing',
    [MODES.CODING_HELP]: 'Coding Help',
    [MODES.TASK_ASSISTANT]: 'Task Assistant',
    [MODES.DEEP_SEARCH]: 'Deep Search'
  };
  return names[mode] || 'Chat';
}

export { MODES };
