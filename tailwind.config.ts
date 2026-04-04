import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        potato: {
          50: '#fef7ee',
          100: '#fdedd6',
          200: '#fad7ac',
          300: '#f6ba77',
          400: '#f19340',
          500: '#ed751a',
          600: '#de5b10',
          700: '#b84410',
          800: '#933615',
          900: '#772f14',
          950: '#401508',
        },
      },
      keyframes: {
        'potato-bounce': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-3px)' },
        },
        'potato-wiggle': {
          '0%, 100%': { transform: 'rotate(0deg)' },
          '25%': { transform: 'rotate(-4deg)' },
          '75%': { transform: 'rotate(4deg)' },
        },
        'potato-tilt': {
          '0%, 100%': { transform: 'rotate(0deg)' },
          '50%': { transform: 'rotate(-6deg)' },
        },
        'potato-sparkle': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.3', transform: 'scale(0.6)' },
        },
        'potato-sweat': {
          '0%': { transform: 'translateY(0)', opacity: '0.7' },
          '100%': { transform: 'translateY(3px)', opacity: '0' },
        },
        'potato-appear': {
          '0%': { opacity: '0', transform: 'scale(0.5)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'potato-bounce': 'potato-bounce 0.6s ease-in-out infinite',
        'potato-wiggle': 'potato-wiggle 0.5s ease-in-out infinite',
        'potato-tilt': 'potato-tilt 2s ease-in-out infinite',
        'potato-sparkle': 'potato-sparkle 0.8s ease-in-out infinite',
        'potato-sweat': 'potato-sweat 1.2s ease-in infinite',
        'potato-appear': 'potato-appear 0.3s ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
