"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { generateGeminiContent } from "@/lib/gemini";
import { validateInput } from "@/lib/validate";
import { atsAnalysisSchema } from "@/lib/schemas/forms";

/**
 * Runs an ATS analysis using Gemini AI and persists the result.
 */
export async function analyzeATS(rawParams) {
  const { userId } = await auth();
  if (!userId) return { success: false, errors: { _form: ["Sign-in required to scan applications."] } };

  // Run through sanitization and bounds parsing before any AI or DB invocation
  const validation = validateInput(atsAnalysisSchema, rawParams);
  if (!validation.success) return { success: false, errors: validation.errors };

  const { resumeContent, jobDescription, jobTitle, companyName } = validation.data;

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });
  if (!user) return { success: false, errors: { _form: ["Active user account not found."] } };

  const prompt = `
You are an expert ATS (Applicant Tracking System) analyst and career coach.

Analyze the following resume against the job description and return a detailed ATS compatibility report.

RESUME:
${resumeContent}

JOB DESCRIPTION:
${jobDescription}

Provide your analysis in the following JSON format ONLY — no extra text, no markdown fences:
{
  "atsScore": <number between 0 and 100>,
  "matchedKeywords": [<array of keywords/skills/phrases found in BOTH the resume and job description>],
  "missingKeywords": [<array of important keywords/skills/phrases in the job description that are missing from the resume>],
  "suggestions": [<array of practical, actionable points to improve the resume for this position>],
  "overallFeedback": "string highlighting overall strengths and key gaps"
}
`;

  try {
    const result = await generateGeminiContent(prompt);
    const text = result.response.text().trim();
    
    // Clean potential markdown packaging additions if injected by AI model
    const cleanJsonText = text.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    const parsedAnalysis = JSON.parse(cleanJsonText);

    const record = await db.aTSAnalysis.create({
      data: {
        userId: user.id,
        jobTitle: jobTitle || "Target Position",
        companyName: companyName || "Target Company",
        jobDescription,
        resumeContent,
        atsScore: Math.min(100, Math.max(0, parsedAnalysis.atsScore || 0)),
        matchedKeywords: (parsedAnalysis.matchedKeywords || []).map(String),
        missingKeywords: (parsedAnalysis.missingKeywords || []).map(String),
        suggestions: parsedAnalysis.suggestions || [],
        overallFeedback: parsedAnalysis.overallFeedback || null,
      },
    });

    revalidatePath("/ats-analyzer");
    return { success: true, data: record };
  } catch (error) {
    console.error("[ATS Action Error]:", error);
    return { success: false, errors: { _form: ["Failed to process and compile target AI report safely."] } };
  }
}

/**
 * Fetches all ATS analyses for the signed-in user, newest first.
 */
export async function getATSAnalyses() {
  const { userId } = await auth();
  if (!userId) return { success: false, errors: { _form: ["Unauthorized"] } };

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });
  if (!user) return { success: false, errors: { _form: ["User not found"] } };

  try {
    const analyses = await db.aTSAnalysis.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    return { success: true, data: analyses };
  } catch (error) {
    console.error("Failed to query ATS listings:", error);
    return { success: false, errors: { _form: ["Failed to retrieve analyses records safely."] } };
  }
}

/**
 * Deletes a specific ATS analysis record (ownership-checked).
 */
export async function deleteATSAnalysis(id) {
  const { userId } = await auth();
  if (!userId) return { success: false, errors: { _form: ["Unauthorized"] } };

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });
  if (!user) return { success: false, errors: { _form: ["User not found"] } };

  try {
    await db.aTSAnalysis.delete({
      where: {
        id,
        userId: user.id,
      },
    });
    revalidatePath("/ats-analyzer");
    return { success: true };
  } catch (error) {
    console.error("Failed to safely delete ATS entry:", error);
    return { success: false, errors: { _form: ["Failed to purge selection from database."] } };
  }
}
