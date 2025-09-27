import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'

describe('App', () => {
  it('renders Photrix title', () => {
    render(<App />)
    expect(screen.getByText('Photrix')).toBeInTheDocument()
  })

  it('renders upload buttons', () => {
    render(<App />)
    const uploadButtons = screen.getAllByText('Upload Photos')
    expect(uploadButtons).toHaveLength(2) // One in toolbar, one in empty state
  })

  it('renders empty state message', () => {
    render(<App />)
    expect(screen.getByText('No photos yet')).toBeInTheDocument()
    expect(screen.getByText('Upload your first photos to get started')).toBeInTheDocument()
  })
})