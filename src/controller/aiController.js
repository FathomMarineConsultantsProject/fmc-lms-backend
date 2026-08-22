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
            model: "gemini-1.5-flash",
            
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