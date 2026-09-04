import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
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
        // We use gemini-1.5-flash as it is the fastest and best suited for text generation tasks
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash", 
            systemInstruction: `You are an expert maritime curriculum designer. 
            Given a course title, generate a highly professional course description. 
            You MUST return the response strictly in the following format, with exactly these headers. Do not use Markdown styling like bold (**), italics, or hashes (##).

Description:
[Write a 2-3 sentence engaging description of the course based on the title]

Key Highlights:
- [Highlight 1]
- [Highlight 2]
- [Highlight 3]
- [Highlight 4]

What you will learn:
- [Objective 1 Title]
  [Objective 1 Description]
- [Objective 2 Title]
  [Objective 2 Description]
- [Objective 3 Title]
  [Objective 3 Description]
- [Objective 4 Title]
  [Objective 4 Description]`
        });

        const prompt = `Generate a course description for the maritime course titled: "${title}"`;
        const result = await model.generateContent(prompt);
        const description = result.response.text();

        return res.json({ description });

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
            model: "gemini-1.5-flash",
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