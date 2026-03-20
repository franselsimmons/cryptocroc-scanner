import manageHandler from "./manage.js";

export default async function handler(req, res) {
  req.query = {
    ...(req.query || {}),
    mode: "bull",
  };
  return manageHandler(req, res);
}