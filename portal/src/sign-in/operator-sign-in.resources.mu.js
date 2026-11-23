import { OperatorSignInViewModel } from "./operator-sign-in-view-model.js";
import { Border, DataTemplate, Orientation, StackPanel, TextBlock, TextWrapping } from "@pragmatic-tech-ai/mural/basic";
import { ContentControl } from "@pragmatic-tech-ai/mural/framework/base/content-control.js";
import { Button, ButtonVariant } from "@pragmatic-tech-ai/mural/framework/buttons/button.js";
import { DataContextBinding, DynamicResource, HorizontalAlignment, ResourceDictionary, Thickness, ToVisibility, VerticalAlignment } from "@pragmatic-tech-ai/mural/runtime";
import { Pen } from "@pragmatic-tech-ai/mural/visual-engine";


const _gate_OperatorSignInResources = Symbol("OperatorSignInResources.ctor");
export class OperatorSignInResources extends ResourceDictionary {
    constructor(_g) {
        super();
        if (_g !== _gate_OperatorSignInResources) {
            throw new Error("OperatorSignInResources is private — use OperatorSignInResources.Clone()");
        }
    }
    static Clone() {
        const t = new OperatorSignInResources(_gate_OperatorSignInResources);
        const _tmpl0 = new DataTemplate((_data) => {
            const _border1 = new Border();
            _border1.set_property_value(Border.FillKey, DynamicResource(_border1, "Bg1"));
            const _stackPanel2 = new StackPanel();
            _stackPanel2.set_property_value(StackPanel.OrientationKey, Orientation.Vertical);
            _stackPanel2.set_property_value(StackPanel.HorizontalAlignmentKey, HorizontalAlignment.Center);
            _stackPanel2.set_property_value(StackPanel.VerticalAlignmentKey, VerticalAlignment.Center);
            const _border3 = new Border();
            _border3.set_property_value(Border.FillKey, DynamicResource(_border3, "Bg0"));
            _border3.set_property_value(Border.StrokeKey, ((_e) => { _e.Brush = DynamicResource(_e, "Border"); return _e; })(new Pen()));
            _border3.set_property_value(Border.PaddingKey, new Thickness(24, 24, 24, 24));
            _border3.set_property_value(Border.VisibilityKey, DataContextBinding(_border3, "StaffSignInOffered", ToVisibility));
            const _stackPanel4 = new StackPanel();
            _stackPanel4.set_property_value(StackPanel.OrientationKey, Orientation.Vertical);
            const _textBlock5 = new TextBlock();
            _textBlock5.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock5, "ProductName"));
            _textBlock5.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock5, "H3"));
            _textBlock5.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock5, "Fg0"));
            _stackPanel4.AddChild(_textBlock5);
            const _textBlock6 = new TextBlock();
            _textBlock6.set_property_value(TextBlock.TextKey, "Operators sign in with their Pragmatic staff account.");
            _textBlock6.set_property_value(TextBlock.StyleKey, DynamicResource(_textBlock6, "Body"));
            _textBlock6.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock6, "Fg2"));
            _textBlock6.set_property_value(TextBlock.MarginKey, new Thickness(0, 4, 0, 16));
            _stackPanel4.AddChild(_textBlock6);
            const _textBlock7 = new TextBlock();
            _textBlock7.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock7, "NoticeText"));
            _textBlock7.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock7, "StateDangerInk"));
            _textBlock7.set_property_value(TextBlock.TextWrappingKey, TextWrapping.Wrap);
            _textBlock7.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 0, 16));
            _textBlock7.set_property_value(TextBlock.VisibilityKey, DataContextBinding(_textBlock7, "NoticeText", ToVisibility));
            _stackPanel4.AddChild(_textBlock7);
            const _button8 = new Button();
            _button8.set_property_value(Button.VariantKey, ButtonVariant.Filled);
            _button8.set_property_value(Button.CommandKey, DataContextBinding(_button8, "StaffSignInCommand"));
            _button8.set_property_value(Button.HorizontalAlignmentKey, HorizontalAlignment.Left);
            const _textBlock9 = new TextBlock();
            _textBlock9.set_property_value(TextBlock.TextKey, "Sign in with Pragmatic staff");
            _button8.Content = _textBlock9;
            _stackPanel4.AddChild(_button8);
            const _button10 = new Button();
            _button10.set_property_value(Button.VariantKey, ButtonVariant.Text);
            _button10.set_property_value(Button.CommandKey, DataContextBinding(_button10, "ToggleBreakGlassCommand"));
            _button10.set_property_value(Button.HorizontalAlignmentKey, HorizontalAlignment.Left);
            _button10.set_property_value(Button.MarginKey, new Thickness(0, 16, 0, 0));
            _button10.set_property_value(Button.VisibilityKey, DataContextBinding(_button10, "ShowsBreakGlassToggle", ToVisibility));
            const _textBlock11 = new TextBlock();
            _textBlock11.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock11, "BreakGlassToggleText"));
            _button10.Content = _textBlock11;
            _stackPanel4.AddChild(_button10);
            _border3.SetChild(_stackPanel4);
            _stackPanel2.AddChild(_border3);
            const _textBlock12 = new TextBlock();
            _textBlock12.set_property_value(TextBlock.TextKey, DataContextBinding(_textBlock12, "NoticeText"));
            _textBlock12.set_property_value(TextBlock.ForegroundKey, DynamicResource(_textBlock12, "StateDangerInk"));
            _textBlock12.set_property_value(TextBlock.TextWrappingKey, TextWrapping.Wrap);
            _textBlock12.set_property_value(TextBlock.MarginKey, new Thickness(0, 0, 0, 16));
            _textBlock12.set_property_value(TextBlock.VisibilityKey, DataContextBinding(_textBlock12, "ShowsNoticeAbovePassword", ToVisibility));
            _stackPanel2.AddChild(_textBlock12);
            const _contentControl13 = new ContentControl();
            _contentControl13.set_property_value(ContentControl.ContentKey, DataContextBinding(_contentControl13, "BreakGlass"));
            _contentControl13.set_property_value(ContentControl.MarginKey, new Thickness(0, 16, 0, 0));
            _contentControl13.set_property_value(ContentControl.VisibilityKey, DataContextBinding(_contentControl13, "ShowsPasswordForm", ToVisibility));
            _stackPanel2.AddChild(_contentControl13);
            _border1.SetChild(_stackPanel2);
            return _border1;
        }, OperatorSignInViewModel);
        t.Set(OperatorSignInViewModel, _tmpl0);
        return t;
    }
}
