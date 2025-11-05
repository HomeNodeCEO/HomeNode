import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Save, X, Plus } from "lucide-react";

// Props are intentionally generic so you can reuse this for any section.
export default function SectionEditModal({
  isOpen,
  onClose,
  section,
  data,
  onSave,
}: {
  isOpen: boolean;
  onClose: (open: boolean) => void;
  section: string;
  data: any;
  onSave: (updates: any, changeLog: any) => Promise<void> | void;
}) {
  const [editData, setEditData] = useState<any>({});
  const [isSaving, setIsSaving] = useState(false);

  React.useEffect(() => {
    if (isOpen) setEditData(data || {});
  }, [isOpen, data]);

  const handleSave = async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const changeLog = {
        section,
        timestamp: new Date().toISOString(),
        user: "Unknown User",
        changeType: "Manual Edit",
        before: data,
        after: editData,
      };
      await onSave(editData, changeLog);
    } catch (err) {
      console.error(err);
      alert("Could not save changes.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSecondaryImprovementChange = (index: number, field: string, value: any) => {
    const next = [...(editData.secondary_improvements || [])];
    if (!next[index]) next[index] = {};
    next[index][field] = value;
    setEditData((p: any) => ({ ...p, secondary_improvements: next }));
  };
  const addSecondaryImprovement = () => {
    const next = [
      ...(editData.secondary_improvements || []),
      { improvement_type: "", construction: "", floor: "", exterior_wall: "", area_sqft: 0 },
    ];
    setEditData((p: any) => ({ ...p, secondary_improvements: next }));
  };
  const removeSecondaryImprovement = (index: number) => {
    const next = (editData.secondary_improvements || []).filter((_: any, i: number) => i !== index);
    setEditData((p: any) => ({ ...p, secondary_improvements: next }));
  };

  const renderFields = () => {
    switch (section) {
      case "Property Details":
        return (
          <div className="space-y-4 max-h-96 overflow-y-auto">
            <div className="grid grid-cols-2 gap-4">
              {/* Add or remove fields to match your section */}
              <div>
                <label className="text-sm font-medium">Square Footage</label>
                <Input
                  type="number"
                  value={editData.square_footage ?? ""}
                  onChange={(e) => setEditData((p: any) => ({ ...p, square_footage: parseInt(e.target.value) || 0 }))}
                />
              </div>
              <div>
                <label className="text-sm font-medium">Total Area Sqft</label>
                <Input
                  type="number"
                  value={editData.total_area_sqft ?? ""}
                  onChange={(e) => setEditData((p: any) => ({ ...p, total_area_sqft: parseInt(e.target.value) || 0 }))}
                />
              </div>
              <div>
                <label className="text-sm font-medium">Stories</label>
                <Input
                  type="number"
                  value={editData.stories ?? ""}
                  onChange={(e) => setEditData((p: any) => ({ ...p, stories: parseInt(e.target.value) || 0 }))}
                />
              </div>
              <div>
                <label className="text-sm font-medium">Bath Count</label>
                <Input
                  type="number"
                  step="0.1"
                  value={editData.bath_count ?? ""}
                  onChange={(e) => setEditData((p: any) => ({ ...p, bath_count: parseFloat(e.target.value) || 0 }))}
                />
              </div>

              {/* Secondary improvements editor */}
              <div className="col-span-2 pt-2">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-medium">Secondary Improvements</h4>
                  <Button size="sm" onClick={addSecondaryImprovement}>
                    <Plus className="w-4 h-4 mr-2" /> Add
                  </Button>
                </div>
                <div className="space-y-3 max-h-48 overflow-auto">
                  {(editData.secondary_improvements || []).map((imp: any, idx: number) => (
                    <div key={idx} className="p-3 border rounded-lg bg-slate-50">
                      <div className="flex justify-between items-center mb-2">
                        <span className="font-medium">#{idx + 1}</span>
                        <Button size="sm" variant="destructive" onClick={() => removeSecondaryImprovement(idx)}>
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          placeholder="Improvement Type"
                          value={imp.improvement_type || ""}
                          onChange={(e) => handleSecondaryImprovementChange(idx, "improvement_type", e.target.value)}
                        />
                        <Input
                          placeholder="Construction"
                          value={imp.construction || ""}
                          onChange={(e) => handleSecondaryImprovementChange(idx, "construction", e.target.value)}
                        />
                        <Input
                          placeholder="Floor"
                          value={imp.floor || ""}
                          onChange={(e) => handleSecondaryImprovementChange(idx, "floor", e.target.value)}
                        />
                        <Input
                          placeholder="Exterior Wall"
                          value={imp.exterior_wall || ""}
                          onChange={(e) => handleSecondaryImprovementChange(idx, "exterior_wall", e.target.value)}
                        />
                        <Input
                          placeholder="Area Sqft"
                          type="number"
                          value={imp.area_sqft || ""}
                          onChange={(e) => handleSecondaryImprovementChange(idx, "area_sqft", parseInt(e.target.value) || 0)}
                        />
                      </div>
                    </div>
                  ))}
                  {(!editData.secondary_improvements || editData.secondary_improvements.length === 0) && (
                    <p className="text-slate-500 text-sm">No secondary improvements yet.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        );

      default:
        return <div className="text-sm text-slate-600">Fields for “{section}” coming soon.</div>;
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit {section}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto p-4">{renderFields()}</div>
        <DialogFooter>
          <DialogClose>
            <Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button>
          </DialogClose>
          <Button onClick={handleSave} disabled={isSaving}>
            <Save className="w-4 h-4 mr-2" />
            {isSaving ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
