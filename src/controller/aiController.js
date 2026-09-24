import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Generation only supplies editable question content; assessment settings and saving stay in the existing flow.
export const generateAssessmentQuestions = async (req, res) => {
    const { title, description, assessment_type, question_count, difficulty_level, category } = req.body || {};
    const types = ["mcq_single", "mcq_multiple", "subjective"];
    if (typeof title !== "string" || !title.trim() || title.length > 200 ||
        typeof description !== "string" || description.length > 2000 ||
        !types.includes(assessment_type) || !Number.isInteger(question_count) ||
        question_count < 1 || question_count > 30 ||
        !["easy", "medium", "hard"].includes(difficulty_level) ||
        (category !== undefined && (typeof category !== "string" || category.length > 100))) {
        return res.status(400).json({ error: "Invalid assessment generation settings." });
    }

    const isSubjective = assessment_type === "subjective";
    const questionProperties = { question_text: { type: SchemaType.STRING } };
    if (!isSubjective) {
        questionProperties.options = {
            type: SchemaType.ARRAY,
            items: {
                type: SchemaType.OBJECT,
                properties: {
                    option_text: { type: SchemaType.STRING },
                    is_correct: { type: SchemaType.BOOLEAN }
                },
                required: ["option_text", "is_correct"]
            }
        };
    }
    const responseSchema = {
        type: SchemaType.OBJECT,
        properties: {
            questions: {
                type: SchemaType.ARRAY,
                items: {
                    type: SchemaType.OBJECT,
                    properties: questionProperties,
                    required: isSubjective ? ["question_text"] : ["question_text", "options"]
                }
            }
        },
        required: ["questions"]
    };

    const validate = (data) => {
        if (!Array.isArray(data?.questions) || data.questions.length !== question_count) return false;
        return data.questions.every((q) => {
            if (typeof q.question_text !== "string" || !q.question_text.trim()) return false;
            if (q.question_type !== undefined && q.question_type !== assessment_type) return false;
            if (isSubjective) return q.options === undefined || (Array.isArray(q.options) && q.options.length === 0);
            if (!Array.isArray(q.options) || q.options.length < 2) return false;
            if (!q.options.every((o) => typeof o.option_text === "string" && o.option_text.trim() && typeof o.is_correct === "boolean")) return false;
            const correct = q.options.filter((o) => o.is_correct).length;
            return assessment_type === "mcq_single" ? correct === 1 : correct >= 1;
        });
    };

    try {
        const model = genAI.getGenerativeModel({
            model: process.env.GEMINI_ASSESSMENT_MODEL || "gemini-3.5-flash-lite",
            generationConfig: { responseMimeType: "application/json", responseSchema, temperature: 0.3 }
        });
        const context = `Title: ${title.trim()}\nDescription: ${description.trim()}\nType: ${assessment_type}\nDifficulty: ${difficulty_level}${category?.trim() ? `\nCategory: ${category.trim()}` : ""}`;
        let hadInvalidResponse = false;
        for (let attempt = 0; attempt < 2; attempt++) {
            const prompt = `Generate exactly ${question_count} distinct maritime assessment questions as JSON matching the schema. ${isSubjective ? "Written questions only; no options or model answers." : assessment_type === "mcq_single" ? "At least two options and exactly one correct option per question." : "At least two options and one or more correct options per question."}\n${context}${hadInvalidResponse ? "\nThe previous response failed validation. Return exactly the requested count and valid option structure." : ""}`;
            let result;
            try {
                result = await model.generateContent(prompt);
            } catch (error) {
                if (attempt === 0 && (error.status === 503 || error.status === 429)) {
                    await new Promise((resolve) => setTimeout(resolve, 1200));
                    continue;
                }
                throw error;
            }
            let data;
            try { data = JSON.parse(result.response.text()); } catch { data = null; }
            if (validate(data)) {
                return res.json({ questions: data.questions.map((q) => isSubjective
                    ? { question_text: q.question_text.trim() }
                    : { question_text: q.question_text.trim(), options: q.options.map((o) => ({ option_text: o.option_text.trim(), is_correct: o.is_correct })) }) });
            }
            hadInvalidResponse = true;
        }
        return res.status(422).json({ error: "Generated questions did not match the requested format." });
    } catch (error) {
        console.error("Assessment generation error:", error);
        return res.status(503).json({ error: "AI generation is temporarily unavailable." });
    }
};

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
