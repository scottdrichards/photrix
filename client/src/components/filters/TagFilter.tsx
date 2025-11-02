import { useState, useEffect } from "react";
import { PillFilter } from "./PillFilter";

// Mock available tags - in a real app, this would come from the API
const mockAvailableTags = [
  "vacation",
  "family",
  "work",
  "nature",
  "cityscape",
  "portrait",
  "landscape",
  "sunset",
  "wildlife",
  "architecture",
  "food",
  "travel",
  "beach",
  "mountain",
  "party",
  "wedding",
  "birthday",
];

export type TagFilterProps = {
  value: string[];
  onChange: (tags: string[]) => void;
};

export const TagFilter = ({ value, onChange }: TagFilterProps) => {
  return (
    <PillFilter
      availableOptions={mockAvailableTags}
      selectedOptions={value}
      onChange={onChange}
      placeholder="Search tags..."
    />
  );
};
