import { readFileSync, writeFileSync } from 'fs';

const file = 'services/generation.service.js';
let src = readFileSync(file, 'utf8');
// Normalize to \n for patching, restore CRLF at end
const hasCRLF = src.includes('\r\n');
if (hasCRLF) src = src.replace(/\r\n/g, '\n');

// 1. Update function signature to include creditMeta + add isCancelled helper
src = src.replace(
  `export const generateVisualPostForEntry = async (workspaceId, entryId, jobId, modelId = 'imagen-3.0-generate-001', postFormat = 'single', aspectRatio = '1:1', carouselCount = 3) => {\n  const pipelineStart = Date.now();\n`,
  `export const generateVisualPostForEntry = async (workspaceId, entryId, jobId, modelId = 'imagen-3.0-generate-001', postFormat = 'single', aspectRatio = '1:1', carouselCount = 3, creditMeta = null) => {\n  const pipelineStart = Date.now();\n\n  // Helper: check if job was cancelled in DB before/between expensive steps\n  const isCancelled = async () => {\n    const job = await GenerationJob.findById(jobId).select('status').lean();\n    if (job?.status === 'cancelled') {\n      logger.info(\`[VisualPost] \u26d4 Job \${jobId} cancelled by user \u2014 aborting pipeline\`);\n      console.log(\`\\n\u26d4 [VisualPost] Job \${jobId} cancelled by user \u2014 stopping pipeline early\`);\n      return true;\n    }\n    return false;\n  };\n`
);

// 2. Add cancellation guard before Step 3
src = src.replace(
  `  // \u2500\u2500 STEP 3: Save GeneratedAsset to DB \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n  console.log('\\n[Step 3/5] \ud83d\udcbe Saving GeneratedAsset to MongoDB...');`,
  `  // \u2500\u2500 CANCELLATION GUARD: Before saving asset (prevents orphan DB records on cancel) \u2500\u2500\n  if (await isCancelled()) return;\n\n  // \u2500\u2500 STEP 3: Save GeneratedAsset to DB \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n  console.log('\\n[Step 3/5] \ud83d\udcbe Saving GeneratedAsset to MongoDB...');`
);

// 3. Add cancellation guard before Step 4 job update
src = src.replace(
  `  // \u2500\u2500 STEP 4: Mark GenerationJob as Completed \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n  console.log('\\n[Step 4/5] \ud83d\udd04 Updating GenerationJob status...');\n  await GenerationJob.findByIdAndUpdate(jobId, {`,
  `  // \u2500\u2500 STEP 4: Mark GenerationJob as Completed \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n  console.log('\\n[Step 4/5] \ud83d\udd04 Updating GenerationJob status...');\n\n  // Final cancellation guard before marking complete\n  if (await isCancelled()) return;\n\n  await GenerationJob.findByIdAndUpdate(jobId, {`
);

// 4. Replace Step 5 block + add post-success credit deduction
src = src.replace(
  `  // \u2500\u2500 STEP 5: Mark CalendarEntry \u2014 LEAVE STATUS UNCHANGED FOR ISOLATION \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n  console.log('\\n[Step 5/5] \ud83d\udcc5 Keeping CalendarEntry status isolated...');\n  // entry.status = 'generated'; // Visual generation should not mark content as generated\n  // await entry.save();\n  console.log(\`    \u2705 Entry \${entryId} status preserved for content generation isolation\`);`,
  `  // \u2500\u2500 STEP 5: CalendarEntry status isolated (no change) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n  console.log('\\n[Step 5/5] \ud83d\udcc5 Keeping CalendarEntry status isolated...');\n  console.log(\`    \u2705 Entry \${entryId} status preserved for content generation isolation\`);\n\n  // \ud83d\udcb0 Deduct credits ONLY on successful pipeline completion (not on cancel/fail)\n  if (creditMeta) {\n    try {\n      await subscriptionService.deductCreditsFromMeta(creditMeta);\n      logger.info(\`[VisualPost] \ud83d\udcb0 Credits deducted for job \${jobId} after successful completion\`);\n    } catch (e) {\n      logger.error(\`[VisualPost] Credit deduction failed post-success: \${e.message}\`);\n    }\n  }`
);

// Restore CRLF if original had it
if (hasCRLF) src = src.replace(/\n/g, '\r\n');

writeFileSync(file, src, 'utf8');

// Verify
const result = readFileSync(file, 'utf8');
const checks = ['isCancelled', 'creditMeta', 'CANCELLATION GUARD', 'Credits deducted'];
checks.forEach(p => console.log(p, '->', result.includes(p) ? '✅ FOUND' : '❌ NOT FOUND'));
