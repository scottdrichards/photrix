import { useState } from 'react'
import { Filter, Grid, List, Upload, Camera } from 'lucide-react'

export default function HomePage() {
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(true)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')

  return (
    <div className="flex w-full">
      {/* Collapsible Filter Panel */}
      <div className={`bg-gray-50 border-r border-gray-200 transition-all duration-300 ${
        isFilterPanelOpen ? 'w-80' : 'w-0'
      } overflow-hidden`}>
        <div className="p-4 w-80">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Filters</h2>
            <button
              onClick={() => setIsFilterPanelOpen(false)}
              className="p-1 text-gray-600 hover:text-gray-900 rounded"
            >
              ✕
            </button>
          </div>
          
          {/* Filter Content */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Date Range
              </label>
              <input
                type="date"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Tags
              </label>
              <div className="space-y-1">
                <label className="flex items-center">
                  <input type="checkbox" className="mr-2" />
                  <span className="text-sm">Favorites</span>
                </label>
                <label className="flex items-center">
                  <input type="checkbox" className="mr-2" />
                  <span className="text-sm">People</span>
                </label>
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Location
              </label>
              <div className="h-32 bg-gray-200 rounded-md flex items-center justify-center text-gray-500 text-sm">
                Map View (To be implemented)
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Photo Area */}
      <div className="flex-1 flex flex-col">
        {/* Toolbar */}
        <div className="bg-white border-b border-gray-200 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              {!isFilterPanelOpen && (
                <button
                  onClick={() => setIsFilterPanelOpen(true)}
                  className="p-2 text-gray-600 hover:text-gray-900 rounded-lg hover:bg-gray-100"
                >
                  <Filter className="h-5 w-5" />
                </button>
              )}
              <span className="text-sm text-gray-600">0 photos</span>
            </div>
            
            <div className="flex items-center space-x-2">
              <button className="btn-primary">
                <Upload className="h-4 w-4 mr-2" />
                Upload Photos
              </button>
              
              <div className="flex border border-gray-300 rounded-lg">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`p-2 ${viewMode === 'grid' ? 'bg-primary-100 text-primary-700' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  <Grid className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`p-2 ${viewMode === 'list' ? 'bg-primary-100 text-primary-700' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  <List className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Photo Grid/List */}
        <div className="flex-1 p-4">
          <div className="h-full flex items-center justify-center text-gray-500">
            <div className="text-center">
              <Camera className="h-16 w-16 mx-auto mb-4 text-gray-300" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No photos yet</h3>
              <p className="text-gray-600 mb-4">Upload your first photos to get started</p>
              <button className="btn-primary">
                <Upload className="h-4 w-4 mr-2" />
                Upload Photos
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Details Panel (Bottom) */}
      <div className="absolute bottom-0 left-0 right-0 bg-white border-t border-gray-200 h-32 transform translate-y-full transition-transform duration-300">
        <div className="p-4">
          <h3 className="text-sm font-medium text-gray-900 mb-2">Photo Details</h3>
          <p className="text-sm text-gray-600">Select a photo to view details</p>
        </div>
      </div>
    </div>
  )
}