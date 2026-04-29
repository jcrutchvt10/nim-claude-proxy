export default {
  default: "minimax",
  models: {
    minimax: {
      model: "meta/llama-3.1-70b-instruct",
      routeAliases: ["mixtral"],
      temperature: 0.3,
      max_tokens: 4096
    },
    mixtral: {
      model: "mistralai/mixtral-8x7b-instruct-v0.1",
      routeAliases: ["minimax"],
      temperature: 0.7,
      max_tokens: 8192
    },
    llama: {
      model: "meta/llama-3.1-70b-instruct",
      routeAliases: ["mixtral"],
      temperature: 0.6,
      max_tokens: 4096
    },
    glm51: {
      model: "z-ai/glm-5.1",
      routeAliases: ["minimax", "mixtral"],
      temperature: 0.3,
      max_tokens: 8192
    }
  }
};