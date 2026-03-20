import manageHandler from "./manage.js";

export default async function handler(req, res) {
  req.query = {
    ...(req.query || {}),
    mode: "bear",
  };
  return manageHandler(req, res);
}