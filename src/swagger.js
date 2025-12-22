import swaggerJSDoc from "swagger-jsdoc";

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "FMC Backend API",
      version: "1.0.0",
    },
    servers: [{ url: "http://localhost:4000" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },

  apis: ["./src/routes/*.js", "./src/controller/*.js"],
};

export default swaggerJSDoc(options);
