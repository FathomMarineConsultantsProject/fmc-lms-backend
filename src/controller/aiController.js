import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { normalizeAssessmentDraft, AssessmentValidationError } from "../services/assessmentService.js";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Define the exact structure the AI must return
const dashboardSchema = {
    type: SchemaType.OBJECT,
    properties: {
        summary_title: { type: SchemaType.STRING },
        smart_tags: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING }
        },
        danger_gauge: {
     
            type: SchemaType.OBJECT,
            properties: {
                score: { type: SchemaType.INTEGER },
                color_code: { type: SchemaType.STRING },
                label: { type: SchemaType.STRING }
            },
            required: ["score", "color_code", "label"]
        },
        radar_chart_data: {
            type: SchemaType.ARRAY,
            items: {
                type: SchemaType.OBJECT,
                properties: {
                    category: { type: SchemaType.STRING },
                    score: { type: SchemaType.INTEGER },
                    full_mark: { type: SchemaType.INTEGER }
                },
                required: ["category", "score", "full_mark"]
            }
        },
        timeline_events: {
            type: SchemaType.ARRAY,
            items: {
                type: SchemaType.OBJECT,
                properties: {
                    step: { type: SchemaType.INTEGER },
                    time: { type: SchemaType.STRING },
                    type: { type: SchemaType.STRING },
                    description: { type: SchemaType.STRING }
                },
                required: ["step", "time", "type", "description"]
            }
        },
        fishbone_mapping: {
            type: SchemaType.OBJECT,
            properties: {
                primary_category: { type: SchemaType.STRING },
                factor: { type: SchemaType.STRING }
            },
            required: ["primary_category", "factor"]
        }
    },
    required: [
        "summary_title",
        "smart_tags",
        "danger_gauge",
        "radar_chart_data",
        "timeline_events",
        "fishbone_mapping"
    ]
};

const model = genAI.getGenerativeModel({
    model: "gemini-flash-latest",
    generationConfig: {
        responseMimeType: "application/json",
        responseSchema: dashboardSchema,
        temperature: 0.2,
    }
})

export async function generateIncidentDashboard(incidentData) {
    const prompt= `
        Analyze the following comprehensive maritime incident report. 
        Extract the key events, identify risks, and categorize the root cause.
        Generate a highly accurate JSON dashboard payload based on this data.

        Incident Metadata:
        - Title: ${incidentData.title || 'N/A'}
        - Incident Type: ${incidentData.incident_type || 'N/A'}
        - Severity: ${incidentData.severity || 'N/A'}
        - Priority: ${incidentData.priority || 'N/A'}
        - Location on Ship: ${incidentData.location_on_ship || 'N/A'}
        - Ship ID: ${incidentData.ship_id || 'N/A'}
        - Date Occurred: ${incidentData.occurred_at ? new Date(incidentData.occurred_at).toLocaleString() : 'N/A'}

        Detailed Incident Description: 
        "${incidentData.description}"
    `;
    const result= await model.generateContent(prompt);
    const responseText = result.response.text();

    return JSON.parse(responseText);
}


//chatbot
export const handleChatBotQuery = async(req,res)=>{
    const {message} = req.body;

    if(!message)
    {
        return res.status(400).json({error:"Message is required"});
    }
    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-3.6-flash",
            
            systemInstruction: `You are an expert AI assistant embedded inside a Maritime Learning Management System (LMS). 
            Your sole purpose is to answer questions related to maritime operations, ships, crew management, marine safety, navigation, and how to use this LMS platform. Keep the answer short and precise.
            If a user asks you a question about programming, cooking, history, general knowledge, or ANYTHING unrelated to maritime operations or the LMS, you must politely refuse. 
            Reply with: "I am a specialized Maritime LMS assistant. I can only answer questions related to marine operations and shipping."`
        });

        const result = await model.generateContent(message);
        const reply = result.response.text();

        return res.json({reply});
    } catch (error) {
        console.error("Gemini API Error:", error);
        return res.status(500).json({ error: "AI server is busy.Please try after some time" });
    }
}


// Generate Course Description API

export const generateCourseDescription = async (req, res) => {
    const { title } = req.body;

    if (!title) {
        return res.status(400).json({ error: "Course title is required" });
    }

    try {
        // 1. Define the exact JSON structure we want
        const descriptionSchema = {
            type: SchemaType.OBJECT,
            properties: {
                short_description: { 
                    type: SchemaType.STRING,
                    description: "A 2-3 sentence engaging description of the course based on the title."
                },
                key_highlights: {
                    type: SchemaType.ARRAY,
                    items: { type: SchemaType.STRING },
                    description: "4 bullet points highlighting the main features of the course."
                },
                what_you_will_learn: {
                    type: SchemaType.ARRAY,
                    items: {
                        type: SchemaType.OBJECT,
                        properties: {
                            title: { type: SchemaType.STRING },
                            details: { type: SchemaType.STRING }
                        },
                        required: ["title", "details"]
                    }
                }
            },
            required: ["short_description", "key_highlights", "what_you_will_learn"]
        };

        //  Initialize the model with the schema
        const model = genAI.getGenerativeModel({
            model: "gemini-3.6-flash", 
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: descriptionSchema,
                temperature: 0.3,
            },
            systemInstruction: "You are an expert maritime curriculum designer. Given a course title, generate a highly professional course description, key highlights, and learning objectives."
        });

        const prompt = `Generate a course description for the maritime course titled: "${title}"`;
        const result = await model.generateContent(prompt);
        const parsedData = JSON.parse(result.response.text());

        //  Return the perfectly structured JSON!
        return res.json(parsedData);

    } catch (error) {
        console.error("Gemini API Error (generateCourseDescription):", error);
        return res.status(500).json({ error: "AI server is busy. Please try again later." });
    }
};

//AI table of content
export const generateTableOfContents = async (req, res) => {
    const { title, description } = req.body;

    if (!title) {
        return res.status(400).json({ error: "Course title is required" });
    }

    try {
        // 1. Define the exact hierarchical structure matching your UI (Chapters -> Items)
        const tocSchema = {
            type: SchemaType.OBJECT,
            properties: {
                chapters: {
                    type: SchemaType.ARRAY,
                    items: {
                        type: SchemaType.OBJECT,
                        properties: {
                            chapter_title: { 
                                type: SchemaType.STRING,
                                description: "The main title of the module or chapter (e.g., 'Ammonia Production and Storage')"
                            },
                            items: {
                                type: SchemaType.ARRAY,
                                items: {
                                    type: SchemaType.OBJECT,
                                    properties: {
                                        content_title: { 
                                            type: SchemaType.STRING,
                                            description: "The specific topic or lesson title (e.g., 'Safety considerations')" 
                                        }
                                    },
                                    required: ["content_title"]
                                }
                            }
                        },
                        required: ["chapter_title", "items"]
                    }
                }
            },
            required: ["chapters"]
        };

        // 2. Initialize Gemini 1.5 Flash with the schema
        const model = genAI.getGenerativeModel({
            model: "gemini-3.6-flash",
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: tocSchema,
                temperature: 0.2, // Low temperature for highly predictable, structured output
            }
        });

        // 3. Create the prompt
        const prompt = `
            Act as an expert maritime instructional designer.
            Generate a comprehensive Table of Contents (curriculum outline) for a course titled "${title}".
            ${description ? `Course Description context: ${description}` : ''}

            Structure it logically into 3 to 5 Chapters (modules). 
            Within each chapter, provide 3 to 5 specific lesson items.
            The content must be highly relevant to maritime training, ship operations, and safety.
        `;

        // 4. Generate and parse the response
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const parsedData = JSON.parse(responseText);

        return res.status(200).json(parsedData);

    } catch (error) {
        console.error("Gemini API Error (generateTableOfContents):", error);
        return res.status(500).json({ error: "AI server is busy. Please try again later." });
    }
};

const AI_ASSESSMENT_TYPES = ["mcq_single", "mcq_multiple"];

/** Generates an unpersisted, staff-reviewable assessment draft. */
export const generateAssessmentDraft = async (req, res) => {
  const description = String(req.body?.description ?? "").trim();
  const assessmentType = req.body?.assessmentType ?? "mcq_single";
  const questionCount = Number(req.body?.questionCount ?? 10);
  const difficultyLevel = String(req.body?.difficultyLevel ?? "medium").trim();

  if (!description) return res.status(400).json({ error: "description is required" });
  if (description.length > 2000) return res.status(400).json({ error: "description must be 2000 characters or fewer" });
  if (!AI_ASSESSMENT_TYPES.includes(assessmentType)) return res.status(400).json({ error: "assessmentType must be mcq_single or mcq_multiple" });
  if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 30) {
    return res.status(400).json({ error: "questionCount must be an integer between 1 and 30" });
  }
  if (!["easy", "medium", "hard"].includes(difficultyLevel)) return res.status(400).json({ error: "difficultyLevel must be easy, medium or hard" });
  const passingPercentage = Number(req.body?.passingPercentage ?? 70);
  const durationMinutes = Number(req.body?.durationMinutes ?? Math.max(5, questionCount * 2));
  if (!Number.isFinite(passingPercentage) || passingPercentage < 0 || passingPercentage > 100) return res.status(400).json({ error: "passingPercentage must be between 0 and 100" });
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1) return res.status(400).json({ error: "durationMinutes must be a positive integer" });

  const draftSchema = {
    type: SchemaType.OBJECT,
    properties: {
      title: { type: SchemaType.STRING },
      description: { type: SchemaType.STRING },
      assessment_type: { type: SchemaType.STRING, enum: [assessmentType] },
      difficulty_level: { type: SchemaType.STRING },
      passing_percentage: { type: SchemaType.NUMBER },
      duration_minutes: { type: SchemaType.INTEGER },
      instructions: { type: SchemaType.STRING },
      questions: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            question_text: { type: SchemaType.STRING },
            question_type: { type: SchemaType.STRING, enum: [assessmentType] },
            marks: { type: SchemaType.NUMBER },
            explanation: { type: SchemaType.STRING },
            options: {
              type: SchemaType.ARRAY,
              items: {
                type: SchemaType.OBJECT,
                properties: { option_text: { type: SchemaType.STRING }, is_correct: { type: SchemaType.BOOLEAN } },
                required: ["option_text", "is_correct"],
              },
            },
          },
          required: ["question_text", "question_type", "marks", "options"],
        },
      },
    },
    required: ["title", "description", "assessment_type", "difficulty_level", "passing_percentage", "duration_minutes", "instructions", "questions"],
  };

  try {
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: "AI generation is not configured" });
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_ASSESSMENT_MODEL || process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
      generationConfig: { responseMimeType: "application/json", responseSchema: draftSchema, temperature: 0.25 },
      systemInstruction: "You create accurate maritime LMS assessments. Produce only educational questions. Do not include IDs, users, scope, timestamps, or database fields outside the requested JSON schema.",
    });
    const prompt = `Create exactly ${questionCount} ${assessmentType} maritime assessment questions on: ${description}. Difficulty: ${difficultyLevel}. Use 3-4 plausible options per question, concise explanations and positive marks. ${assessmentType === "mcq_single" ? "Exactly one correct option per question." : "At least one correct option per question."}`;
    let draft;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await model.generateContent(attempt === 0 ? prompt : `${prompt}\nYour previous response had the wrong question count. Return exactly ${questionCount} questions.`);
      const raw = JSON.parse(result.response.text());
      draft = normalizeAssessmentDraft({ ...raw, title: req.body?.title || raw.title, assessment_type: assessmentType, difficulty_level: difficultyLevel, passing_percentage: passingPercentage, duration_minutes: durationMinutes, instructions: req.body?.instructions || raw.instructions });
      if (draft.questions.length === questionCount) break;
    }
    if (draft.questions.length !== questionCount) throw new AssessmentValidationError("Generated question count did not match the request");
    return res.json({ success: true, data: { ...draft, total_marks: draft.questions.reduce((sum, question) => sum + question.marks, 0) } });
  } catch (error) {
    console.error("Gemini assessment draft generation failed:", error?.message);
    const status = error instanceof AssessmentValidationError || error instanceof SyntaxError ? 422 : 502;
    return res.status(status).json({ error: status === 422 ? "AI returned an invalid assessment draft. Please try again." : "Assessment generation is temporarily unavailable. Please try again." });
  }
};
