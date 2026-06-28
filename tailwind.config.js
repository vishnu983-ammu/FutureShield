/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./card.html",
    "./mobile/www/index.html",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
