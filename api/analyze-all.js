export default async function handler(req, res) {
  res.status(200).json({
    main: {
      problems: [
        {
          symbol: "BTC",
          stage: "Early",
          score: 8.2,
          bottlenecks: ["Liquiditeit laag"],
          advice: ["Wacht op meer volume"],
        },
        {
          symbol: "ETH",
          stage: "Mid",
          score: 5.1,
          bottlenecks: ["Timing mismatch"],
          advice: ["Breakout afwachten"],
        },
      ],
    },
    moon: {
      bull: {
        problems: [
          {
            symbol: "SOL",
            stage: "Bull Run",
            score: 9.5,
            bottlenecks: [],
            advice: ["HODL"],
          },
        ],
      },
      bear: {
        problems: [],
      },
    },
    trade: {
      problems: [
        {
          symbol: "DOGE",
          stage: "Volatile",
          score: 3.2,
          bottlenecks: ["Markt tegen", "Slechte kwaliteit"],
          advice: ["Niet traden"],
        },
      ],
    },
  });
}