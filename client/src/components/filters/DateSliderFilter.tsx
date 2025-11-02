import { useState, useEffect } from "react";
import {
  Label,
  Slider,
  makeStyles,
  tokens,
} from "@fluentui/react-components";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  sliderContainer: {
    padding: `${tokens.spacingVerticalS} 0`,
  },
  dateLabels: {
    display: "flex",
    justifyContent: "space-between",
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  selectedRange: {
    textAlign: "center",
    fontWeight: tokens.fontWeightSemibold,
    marginTop: tokens.spacingVerticalXS,
  },
});

export type DateSliderFilterProps = {
  value?: {
    start?: string;
    end?: string;
  };
  onChange: (range?: { start?: string; end?: string }) => void;
  minDate?: Date;
  maxDate?: Date;
};

const formatDate = (date: Date): string => {
  return date.toISOString().split("T")[0];
};

const formatDisplayDate = (date: Date): string => {
  return date.toLocaleDateString(undefined, { 
    year: "numeric", 
    month: "short",
    day: "numeric"
  });
};

export const DateSliderFilter = ({
  value,
  onChange,
  minDate = new Date(new Date().getFullYear() - 10, 0, 1),
  maxDate = new Date(),
}: DateSliderFilterProps) => {
  const styles = useStyles();
  
  const minTime = minDate.getTime();
  const maxTime = maxDate.getTime();
  const range = maxTime - minTime;

  // Convert value to slider position (0-100)
  const getSliderValue = (): [number, number] => {
    const startTime = value?.start ? new Date(value.start).getTime() : minTime;
    const endTime = value?.end ? new Date(value.end).getTime() : maxTime;
    
    const startPercent = ((startTime - minTime) / range) * 100;
    const endPercent = ((endTime - minTime) / range) * 100;
    
    return [Math.max(0, Math.min(100, startPercent)), Math.max(0, Math.min(100, endPercent))];
  };

  const [sliderValue, setSliderValue] = useState<[number, number]>(getSliderValue());

  useEffect(() => {
    setSliderValue(getSliderValue());
  }, [value]);

  const handleSliderChange = (newValue: number | number[]) => {
    const values = Array.isArray(newValue) ? newValue : [0, newValue];
    const [startPercent, endPercent] = values as [number, number];
    
    setSliderValue([startPercent, endPercent]);

    const startTime = minTime + (startPercent / 100) * range;
    const endTime = minTime + (endPercent / 100) * range;
    
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);

    onChange({
      start: formatDate(startDate),
      end: formatDate(endDate),
    });
  };

  const currentStartDate = new Date(minTime + (sliderValue[0] / 100) * range);
  const currentEndDate = new Date(minTime + (sliderValue[1] / 100) * range);

  return (
    <div className={styles.container}>
      <div className={styles.sliderContainer}>
        <Slider
          min={0}
          max={100}
          value={sliderValue[1]}
          onChange={(_, data) => handleSliderChange([sliderValue[0], data.value])}
        />
      </div>
      <div className={styles.dateLabels}>
        <span>{formatDisplayDate(minDate)}</span>
        <span>{formatDisplayDate(maxDate)}</span>
      </div>
      <div className={styles.selectedRange}>
        {formatDisplayDate(currentStartDate)} - {formatDisplayDate(currentEndDate)}
      </div>
    </div>
  );
};
