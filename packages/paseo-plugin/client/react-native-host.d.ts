/**
 * Types for the `react-native` module the Paseo host hands to plugin client code.
 *
 * Paseo renders plugin UI with React Native: natively on iOS/Android, through react-native-web on
 * desktop. The host resolves `import … from "react-native"` to its own copy at load time (see
 * `@getpaseo/plugin`'s optional `react-native` peer), so the plugin never installs it. The real
 * package would pull ~290 packages into this workspace just for types, so this file declares the
 * narrow subset the panel uses instead.
 *
 * The style types are deliberately strict: numbers where native needs numbers (`lineHeight`,
 * `padding`, `borderWidth`), no CSS shorthands (`border: "1px solid"`), and no web-only keys
 * (`cursor`, `whiteSpace`, `boxSizing`). A style that would only work on desktop fails to compile.
 * `test/native-render.test.tsx` checks the same rules at runtime.
 */

declare module "react-native" {
  import type { Component, ReactNode } from "react";

  type DimensionValue = number | "auto" | `${number}%`;
  type ColorValue = string;

  interface FlexStyle {
    alignItems?: "flex-start" | "flex-end" | "center" | "stretch" | "baseline";
    alignSelf?: "auto" | "flex-start" | "flex-end" | "center" | "stretch" | "baseline";
    justifyContent?:
      | "flex-start"
      | "flex-end"
      | "center"
      | "space-between"
      | "space-around"
      | "space-evenly";
    flex?: number;
    flexGrow?: number;
    flexShrink?: number;
    flexBasis?: DimensionValue;
    flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
    flexWrap?: "wrap" | "nowrap" | "wrap-reverse";
    gap?: number;
    rowGap?: number;
    columnGap?: number;
    width?: DimensionValue;
    height?: DimensionValue;
    minWidth?: DimensionValue;
    maxWidth?: DimensionValue;
    minHeight?: DimensionValue;
    maxHeight?: DimensionValue;
    margin?: DimensionValue;
    marginTop?: DimensionValue;
    marginBottom?: DimensionValue;
    marginLeft?: DimensionValue;
    marginRight?: DimensionValue;
    marginHorizontal?: DimensionValue;
    marginVertical?: DimensionValue;
    padding?: DimensionValue;
    paddingTop?: DimensionValue;
    paddingBottom?: DimensionValue;
    paddingLeft?: DimensionValue;
    paddingRight?: DimensionValue;
    paddingHorizontal?: DimensionValue;
    paddingVertical?: DimensionValue;
    overflow?: "visible" | "hidden" | "scroll";
    display?: "flex" | "none";
  }

  export interface ViewStyle extends FlexStyle {
    backgroundColor?: ColorValue;
    borderColor?: ColorValue;
    borderTopColor?: ColorValue;
    borderWidth?: number;
    borderTopWidth?: number;
    borderRadius?: number;
    opacity?: number;
  }

  export interface TextStyle extends ViewStyle {
    color?: ColorValue;
    fontSize?: number;
    fontFamily?: string;
    fontWeight?: "normal" | "bold" | "400" | "500" | "600" | "700";
    lineHeight?: number;
    textAlign?: "auto" | "left" | "right" | "center";
    textAlignVertical?: "auto" | "top" | "bottom" | "center";
  }

  type Falsy = false | null | undefined;
  export type StyleProp<T> = T | Falsy | readonly StyleProp<T>[];

  interface AccessibilityProps {
    accessibilityLabel?: string;
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: "auto" | "yes" | "no" | "no-hide-descendants";
  }

  export interface ViewProps extends AccessibilityProps {
    style?: StyleProp<ViewStyle>;
    children?: ReactNode;
    testID?: string;
  }

  export interface TextProps extends AccessibilityProps {
    style?: StyleProp<TextStyle>;
    children?: ReactNode;
    numberOfLines?: number;
    selectable?: boolean;
    testID?: string;
  }

  export interface PressableStateCallbackType {
    readonly pressed: boolean;
  }

  export interface PressableProps extends AccessibilityProps {
    onPress?: () => void;
    disabled?: boolean;
    style?: StyleProp<ViewStyle> | ((state: PressableStateCallbackType) => StyleProp<ViewStyle>);
    children?: ReactNode;
    accessibilityRole?: "button";
    accessibilityState?: { disabled?: boolean; expanded?: boolean; selected?: boolean };
    hitSlop?: number;
    testID?: string;
  }

  export interface ScrollViewProps extends ViewProps {
    contentContainerStyle?: StyleProp<ViewStyle>;
    horizontal?: boolean;
    nestedScrollEnabled?: boolean;
    keyboardShouldPersistTaps?: "always" | "never" | "handled";
  }

  export interface TextInputProps extends AccessibilityProps {
    value?: string;
    onChangeText?: (text: string) => void;
    placeholder?: string;
    placeholderTextColor?: ColorValue;
    multiline?: boolean;
    numberOfLines?: number;
    editable?: boolean;
    autoCapitalize?: "none" | "sentences" | "words" | "characters";
    autoCorrect?: boolean;
    style?: StyleProp<TextStyle>;
    testID?: string;
  }

  export const View: (props: ViewProps) => ReactNode;
  export const Text: (props: TextProps) => ReactNode;
  export const Pressable: (props: PressableProps) => ReactNode;
  export class ScrollView extends Component<ScrollViewProps> {}
  export class TextInput extends Component<TextInputProps> {}

  export const Platform: {
    readonly OS: "ios" | "android" | "web" | "windows" | "macos";
    select<T>(specifics: { ios?: T; android?: T; web?: T; native?: T; default?: T }): T;
  };
}
