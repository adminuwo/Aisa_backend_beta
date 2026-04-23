/**
 * Advanced Image Generation Controller Utility
 * Handles text detection, placement, styling, and quality refinement.
 */

import { askOpenAI } from '../services/openai.service.js';
import logger from './logger.js';

export const IMAGE_CONTROLLER_SYSTEM_PROMPT = `
You are an advanced image generation controller for AISA™. 
Your task is to generate a highly detailed prompt for an image generation model (like Imagen 3) based on the user's initial request. 
The goal is to produce high-quality, visually appealing images AND intelligently embed text inside the image.

### AISA™ BRAND IDENTITY:
- Name: AISA™
- Vibe: Futuristic, Modern, Premium, Intelligent, Clean, Reliable.
- Visuals: Glowing blue and purple neural brain logo, glassmorphism, deep space blue backgrounds, advanced neural networks.
- Identity: If the user mentions "AISA" or refers to "your logo/image", ensure the refined prompt incorporates these official brand elements.

### CORE RULES:

1. TEXT DETECTION & INFERENCE
- Extract any title, slogan, or quote from the user prompt.
- If text is not explicitly mentioned but would fit the context (e.g., "A poster for a coffee shop"), infer a short, catchy title (max 6–8 words).

2. TEXT PLACEMENT
- Describe the text placement in a visually balanced area (top-center, sky area, or empty space).
- Avoid overlapping important subjects (faces, objects, focal points).
- Ensure proper spacing and alignment.

3. TEXT STYLE & COLOR PSYCHOLOGY
- Use bold, clean, modern typography (sans-serif for tech/modern, elegant serif for premium).
- Ensure high contrast between text and background.
- Add subtle shadows, glow, or stroke for readability.
- Green/nature topics -> green/orange/white tones.
- Dark backgrounds -> light/glowing text.
- Bright backgrounds -> darker, solid text.

4. TEXT HIERARCHY
- Highlight key words differently if applicable (e.g., different colors or weights).
- Maintain consistent font family across the composition.

5. IMAGE QUALITY & COMPOSITION
- Style: Ultra-realistic or high-quality digital illustration.
- Lighting: Cinematic, soft natural light, bokeh effects.
- Depth: Clear separation between foreground, midground, and background.
- Details: Rich textures, vibrant colors, sharp edges.
- Composition: Main subject centered or follows rule-of-thirds.

6. PROFESSIONAL POSTER FORMAT
- The final refined prompt must result in a professional poster, banner, or cinematic visual.
- Text must feel naturally integrated into the scene, not just an overlay.

7. STRICT CONSTRAINT
- DO NOT return plain images without text if the prompt implies the need for text.
- Ensure the text is spelled EXACTLY as requested or inferred.
- NEVER distorted or misspell text.

8. TYPOGRAPHY AWARENESS
- Treat text as a design element, not an afterthought.
- Maintain margins and padding.
- Ensure readability even on mobile screens.

9. AISA™ BRANDING INTEGRATION
- If the user mentions "AISA" or refers to "your logo/image", ensure the refined prompt incorporates the official AISA™ brand elements (glowing blue and purple neural brain logo, glassmorphism, deep space blue backgrounds, advanced neural networks).

RESPOND ONLY WITH THE FINAL REFINED PROMPT. DO NOT ADD ANY EXPLANATION OR CONVERSATION.
`;

export const IMAGE_EDIT_CONTROLLER_SYSTEM_PROMPT = `
You are an advanced IMAGE TRANSFORMATION controller for AISA™.
Your task is to write a precise, detailed image generation prompt that will be used by an AI model to transform the provided reference image based on the user's request.

The AI model you are writing for:
- Receives the original image as a reference/face anchor
- Generates a NEW image applying the user's requested transformations
- Preserves the identity/face of the person from the reference image

⚠️ CRITICAL RULES:

----------------------------------------
1. FOR STYLISTIC / SCENE TRANSFORMS (user wants a different style, location, outfit, background):
----------------------------------------
- Write a FULL image generation prompt describing the NEW scene/style entirely.
- USE the reference image only to anchor the person's face and identity.
- Example: "A photo-realistic editorial close-up of a [describe the same person from the reference] wearing [requested outfit], seated on [requested prop], [requested background scene], [camera angle], [lighting]."
- Be SPECIFIC: describe every visual element from the user's request.

----------------------------------------
2. FOR MINOR EDITS (add text, remove background, change small object):
----------------------------------------
- Describe what to KEEP and what to CHANGE precisely.
- For background removal: "Remove the background, keep the subject with a transparent/white background."
- For text addition: state the exact text in quotes and exact position.

----------------------------------------
3. FACE / IDENTITY PRESERVATION:
----------------------------------------
- Always include "same face and hairstyle as reference image" in the prompt.
- Never change gender, age, or core identity unless explicitly requested.

----------------------------------------
4. TEXT ACCURACY PROTOCOL:
----------------------------------------
- Render any text CHARACTER-BY-CHARACTER.
- State text exactly as requested in double quotes.

----------------------------------------
5. PRECISION PRIORITY:
----------------------------------------
- Accuracy > creativity. Follow the user's request literally.
- Output a high-quality, photorealistic prompt unless a specific art style is requested.

----------------------------------------
INPUT IMAGE: [reference image of person/scene]
USER REQUEST: {{EDIT_PROMPT}}

----------------------------------------
OUTPUT FORMAT:
Return a JSON configuration block, then the detailed generation prompt on a new line.

{
  "mode": "transform",
  "preserve_face": true,
  "new_scene": true,
  "edit_mode": "inpainting-insert"
}
A high-end editorial close-up of a stylish young man (same face and hairstyle as reference image) wearing modern glasses, seated on a royal blue armchair. Shot in a tight mid-shot / close-up angle, focusing on facial expression and upper outfit details. The cobalt blue geometric outfit texture is crisp and detailed. Shallow depth of field, blurred background, soft luxury lighting, glossy skin tones, fashion magazine aesthetic, ultra-detailed, 4K.
----------------------------------------
`;

/**
 * Refines a user prompt using the Advanced Controller logic.
 * @param {string} userPrompt - The raw user prompt.
 * @returns {Promise<string>} - The refined prompt for the image generator.
 */
export const refineAdvancedImagePrompt = async (userPrompt) => {
    try {
        console.log(`[Image Controller] Refining prompt: "${userPrompt}"`);
        
        const refinedPrompt = await askOpenAI(userPrompt, null, {
            systemInstruction: IMAGE_CONTROLLER_SYSTEM_PROMPT
        });

        if (refinedPrompt) {
            console.log(`[Image Controller] Refined output: "${refinedPrompt.substring(0, 100)}..."`);
            return refinedPrompt;
        }

        return userPrompt; // Fallback
    } catch (error) {
        console.error(`[Image Controller] Refinement failed: ${error.message}`);
        return userPrompt; // Fallback to original
    }
};

/**
 * Refines an edit prompt using the Advanced Image Editing Assistant logic.
 * @param {string} userEditText - User's raw edit instruction.
 * @param {string} imageUrl - Reference image URL.
 * @returns {Promise<string>} - Refined instruction for the image editor.
 */
export const refineAdvancedEditPrompt = async (userEditText, imageUrl = "", imageBase64 = null) => {
    try {
        console.log(`[Image Editor Controller] Refining edit request: "${userEditText}" (Image: ${!!imageUrl || !!imageBase64})`);

        const compositePrompt = `
USER EDIT REQUEST: ${userEditText}

Describe the original image scene (subjects, position, background, lighting) and then provide your refined technical instruction according to the rules.
`;

        const refinedInstruction = await askOpenAI(compositePrompt, null, {
            systemInstruction: IMAGE_EDIT_CONTROLLER_SYSTEM_PROMPT,
            image: imageBase64 || imageUrl
        });

        if (refinedInstruction) {
            console.log(`[Image Editor Controller] Refined output received.`);
            
            // Extract JSON if present
            let cleanPrompt = refinedInstruction;
            let config = null;
            
            try {
                // Remove potential markdown code block wrappers
                const jsonMatch = refinedInstruction.match(/\{[\s\S]*?\}/);
                if (jsonMatch) {
                    config = JSON.parse(jsonMatch[0]);
                    cleanPrompt = refinedInstruction.replace(/```json|```/g, '').replace(jsonMatch[0], '').trim();
                    // Clean up any remaining labels or formatting
                    cleanPrompt = cleanPrompt.replace(/^Refined Prompt:\s*/i, '').replace(/^- /g, '').trim();
                }
            } catch (e) {
                console.warn("[Image Editor Controller] Failed to parse JSON config from response", e.message);
            }

            // FALLBACK: If extraction left us with an empty prompt, use the user's original text
            if (!cleanPrompt || cleanPrompt.trim().length === 0) {
                cleanPrompt = userEditText;
            }

            return { prompt: cleanPrompt, config };
        }

        return { prompt: userEditText, config: null }; // Fallback
    } catch (error) {
        console.error(`[Image Editor Controller] Refinement failed: ${error.message}`);
        return { prompt: userEditText, config: null }; // Fallback to original
    }
};

export const FOLLOW_UP_PROMPTS_SYSTEM_PROMPT = `
You are a smart suggestion engine for image modifications.
Generate exactly 4 highly relevant, context-aware, and ACTION-ORIENTED follow-up prompts.

STRICT RULES:
1. NO GENERIC SUGGESTIONS: Never return "Change style", "Add more detail", or "Make it better".
2. ACTION-ORIENTED: Suggestions must be specific steps (e.g., "Add futuristic lighting effects").
3. LENGTH: 5–10 words max.
4. FORMAT: Return ONLY a numbered list of strings.
`;

/**
 * Generates follow-up image prompts based on the original user prompt.
 * @param {string} userPrompt - The original prompt provided by the user.
 * @returns {Promise<Array<string>>} - Array of follow-up prompts.
 */
export const generateFollowUpPrompts = async (userPrompt, imageUrl = null) => {
    try {
        console.log(`[Image Controller] Generating follow-up prompts for: "${userPrompt}"`);
        
        let promptArgs = `Original user prompt:\n"${userPrompt}"`;
        if (imageUrl) {
            promptArgs += `\nThe generated image is attached. Please base your suggestions on the visual details in the generated image AND the original prompt.`;
        }

        const response = await askOpenAI(promptArgs, null, {
            systemInstruction: FOLLOW_UP_PROMPTS_SYSTEM_PROMPT,
            image: imageUrl
        });

        if (response) {
            // Parse numbered list into an array of strings and strip surrounding quotes
            const prompts = response.split('\n')
                .map(line => line.replace(/^\d+\.\s*/, '').replace(/^-+\s*/, '').replace(/^"+|"+$/g, '').trim())
                .filter(line => line.length > 0 && !line.toLowerCase().includes("here is") && !line.toLowerCase().includes("sure"));
            return prompts.slice(0, 4); // Extra safety
        }
        return [];
    } catch (error) {
        console.error(`[Image Controller] Follow-up prompt generation failed: ${error.message}`);
        return [];
    }
};
