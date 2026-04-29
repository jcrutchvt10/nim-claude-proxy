export default {
  default: "minimax",
  models: {
    minimax: {
      model: "meta/llama-3.1-70b-instruct",
      temperature: 0.3,
      max_tokens: 4096
    },
    mixtral: {
      model: "mistralai/mixtral-8x7b-instruct-v0.1",
      temperature: 0.7,
      max_tokens: 8192
    },
    llama: {
      model: "meta/llama-3.1-70b-instruct",
      temperature: 0.6,
      max_tokens: 4096
    }
  }
};