import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../store'
import { Check } from 'lucide-react'

const steps = [
  { label: 'Select Device', step: 1, path: '/' },
  { label: 'Configure', step: 2, path: '/scan-config' },
  { label: 'Scan', step: 3, path: '/scanning' },
  { label: 'Select Files', step: 4, path: '/files' },
  { label: 'Recover', step: 5, path: '/recovery' }
]

export default function StepIndicator() {
  const navigate = useNavigate()
  const currentStep = useAppStore((s) => s.currentStep)

  const handleClick = (step: number, path: string) => {
    if (step < currentStep) {
      navigate(path)
    }
  }

  return (
    <div className="flex items-center gap-1">
      {steps.map(({ label, step, path }, idx) => {
        const isCompleted = step < currentStep
        const isCurrent = step === currentStep
        const isUpcoming = step > currentStep

        return (
          <div key={step} className="flex items-center">
            {/* Step circle + label */}
            <button
              type="button"
              onClick={() => handleClick(step, path)}
              disabled={!isCompleted}
              className={`flex items-center gap-2 ${isCompleted ? 'cursor-pointer' : 'cursor-default'}`}
            >
              <div
                className={`
                  flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors
                  ${isCompleted ? 'bg-primary-600 text-white hover:bg-primary-500' : ''}
                  ${isCurrent ? 'bg-primary-500 text-white ring-2 ring-primary-400/40' : ''}
                  ${isUpcoming ? 'bg-surface-lighter text-gray-500' : ''}
                `}
              >
                {isCompleted ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  step
                )}
              </div>
              <span
                className={`
                  text-xs font-medium transition-colors
                  ${isCurrent ? 'text-white' : ''}
                  ${isCompleted ? 'text-gray-400 hover:text-gray-200' : ''}
                  ${isUpcoming ? 'text-gray-600' : ''}
                `}
              >
                {label}
              </span>
            </button>

            {/* Connector line */}
            {idx < steps.length - 1 && (
              <div
                className={`
                  mx-3 h-px w-8 transition-colors
                  ${step < currentStep ? 'bg-primary-600' : 'bg-surface-lighter'}
                `}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
