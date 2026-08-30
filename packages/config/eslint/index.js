import { requireWithUser } from "./rules/require-with-user.js";

export const pentefino = {
  plugins: {
    pentefino: { rules: { "require-with-user": requireWithUser } },
  },
  rules: {
    "pentefino/require-with-user": "error",
  },
};
