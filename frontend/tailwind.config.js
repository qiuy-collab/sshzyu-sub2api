/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // SSHZYU: one blue accent, porcelain surfaces and neutral graphite.
        primary: {
          50: '#f0f6ff',
          100: '#e2efff',
          200: '#bfdaff',
          300: '#8dbdff',
          400: '#4c9aff',
          500: '#007aff',
          600: '#0071e3',
          700: '#005ebd',
          800: '#004b96',
          900: '#163f6b',
          950: '#102743'
        },
        gray: {
          50: '#f5f5f7',
          100: '#efeff1',
          200: '#e5e5e7',
          300: '#d2d2d7',
          400: '#929298',
          500: '#6e6e73',
          600: '#55555b',
          700: '#424247',
          800: '#2d2d31',
          900: '#1d1d1f',
          950: '#111113'
        },
        // 辅助色 - 深蓝灰
        accent: {
          50: '#fafafa',
          100: '#f5f5f7',
          200: '#e5e5e7',
          300: '#d2d2d7',
          400: '#98989f',
          500: '#77777f',
          600: '#56565e',
          700: '#3a3a40',
          800: '#28282d',
          900: '#1c1c1f',
          950: '#141416'
        },
        // 深色模式背景
        dark: {
          50: '#fafafa',
          100: '#f5f5f7',
          200: '#e5e5e7',
          300: '#d2d2d7',
          400: '#a1a1a8',
          500: '#85858d',
          600: '#56565e',
          700: '#3a3a40',
          800: '#28282d',
          900: '#1c1c1f',
          950: '#141416'
        }
      },
      fontFamily: {
        sans: [
          'PingFang SC',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'sans-serif'
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace']
      },
      boxShadow: {
        glass: '0 16px 48px -20px rgba(29, 29, 31, 0.14)',
        'glass-sm': '0 4px 16px rgba(29, 29, 31, 0.04)',
        glow: '0 1px 2px rgba(29, 29, 31, 0.04)',
        'glow-lg': '0 2px 8px rgba(29, 29, 31, 0.06)',
        card: '0 1px 2px rgba(29, 29, 31, 0.025)',
        'card-hover': '0 6px 20px rgba(29, 29, 31, 0.06)',
        'inner-glow': 'inset 0 1px 0 rgba(255, 255, 255, 0.1)'
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-primary': 'linear-gradient(#0071e3, #0071e3)',
        'gradient-dark': 'linear-gradient(#1c1c1f, #1c1c1f)',
        'gradient-glass':
          'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%)',
        'mesh-gradient': 'none'
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-down': 'slideDown 0.3s ease-out',
        'slide-in-right': 'slideInRight 0.3s ease-out',
        'scale-in': 'scaleIn 0.2s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        shimmer: 'shimmer 2s linear infinite',
        glow: 'glow 2s ease-in-out infinite alternate'
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' }
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(20px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' }
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' }
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' }
        },
        glow: {
          '0%': { boxShadow: '0 0 20px rgba(20, 184, 166, 0.25)' },
          '100%': { boxShadow: '0 0 30px rgba(20, 184, 166, 0.4)' }
        }
      },
      backdropBlur: {
        xs: '2px'
      },
      borderRadius: {
        '4xl': '2rem'
      }
    }
  },
  plugins: []
}
